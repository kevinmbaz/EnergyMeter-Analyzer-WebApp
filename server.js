'use strict';

/**
 * TPM-04-100D Energy Analytics — Node.js server (no dependencies).
 *
 * Phase 1 (current): GUI-first. Data comes from a built-in simulator so the
 * dashboard can be designed and verified without the ESP32.
 * Phase 2 (next): point this at the ESP32 readings (see README, /api/ingest).
 *
 * Endpoints:
 *   GET  /api/status            server + data-source status
 *   GET  /api/readings          latest measurement snapshot
 *   GET  /api/history?range=    time series (live|1h|6h|24h|7d)
 *   POST /api/sim               control the simulator (dev tool)
 *   POST /api/ingest            accept readings pushed by the ESP32 (Phase 2)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');


const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

// Persistent storage (SQLite via node:sqlite — no external service needed)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'energymeter.db');
const DB_RETENTION_DAYS = Number(process.env.DB_RETENTION_DAYS || 0); // 0 = keep forever
const RAW_EXPORT_MAX_ROWS = 100000; // refuse raw CSV larger than this; use minute/hour grouping

// ESP32 data source (phase 2)
const ESP32_URL = process.env.ESP32_URL ?? 'http://energymeter.local/api/readings';
const ESP32_POLL_MS = Math.max(1000, Number(process.env.ESP32_POLL_MS || 2000));
const ESP32_TIMEOUT_MS = Number(process.env.ESP32_TIMEOUT_MS || 4000);
// Connection grace period is independent of meter sample freshness.
const ESP32_CONNECTION_TIMEOUT_MS = 8000;
const DEVICE_STALE_MS = 15000;
// Optional shared secret for POST /api/ingest (header: X-Ingest-Token).
// Off by default; set when ingesting over a public network.
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
// Bind metadata to this ESP32, not the meter's Modbus slave address or a
// caller-supplied identity. Each configured device retains its own DB row.
const ESP32_DEVICE_ID = process.env.ESP32_DEVICE_ID || 'energymeter';

// ---------------------------------------------------------------- OTA
// Private pull-based firmware hosting for the ESP32. Fail closed: without
// OTA_TOKEN every OTA request is rejected. OTA endpoints additionally only
// accept connections from the configured CIDRs (tailnet by default).
const OTA_TOKEN = process.env.OTA_TOKEN || '';
const OTA_DIR = process.env.OTA_DIR || path.join(__dirname, 'firmware');
const OTA_MANIFEST_FILE = path.join(OTA_DIR, 'manifest.json');
const OTA_SIZE_CAP = 0x3f0000;   // ESP32-S3 OTA partition budget
const OTA_ALLOW_CIDRS = (process.env.OTA_ALLOW_CIDRS
  || '100.64.0.0/10,127.0.0.1/32,::1/128').split(',').map(s => s.trim()).filter(Boolean);
const OTA_SEMVER = /^\d+\.\d+\.\d+$/;
const OTA_UPLOAD_LIMIT = OTA_SIZE_CAP + 65536; // upload body cap with slack
const OTA_PROJECT = 'EnergyAnalyzer';          // project name baked into app_desc
const OTA_LAYOUT = 'energymeter-ota-v1';       // manifest layout for this feed

// Running firmware is device-reported metadata, never the published OTA release.
function validFirmwareVersion(value) {
  if (typeof value !== 'string' || value.length > 17) return null;
  const match = /^[0-9]{1,5}(?:\.[0-9]{1,5}){2}$/.exec(value);
  if (!match || match[0] !== value || value.split('.').some(n => Number(n) > 65535)) return null;
  return value;
}
function otaVersionFromUA(ua) {
  if (typeof ua !== 'string' || ua.length > 36) return null;
  const m = /^EnergyAnalyzer-OTA\/(\d+\.\d+\.\d+)$/.exec(ua);
  return m && m[0] === ua ? validFirmwareVersion(m[1]) : null;
}
function recordDeviceVersion(value, source) {
  const version = validFirmwareVersion(value);
  if (!version) return;
  const at = Date.now();
  if (db) {
    db.prepare(`INSERT INTO device_firmware (device_id, version, reported_at, source)
      VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET
      version = excluded.version, reported_at = excluded.reported_at, source = excluded.source`)
      .run(ESP32_DEVICE_ID, version, at, source);
  }
  state.otaReported = { version, at, source };
}
function firmwareStatus(now = Date.now()) {
  const report = state.otaReported;
  const age = report.at === null ? null : Math.max(0, now - report.at);
  return { device_id: ESP32_DEVICE_ID, version: report.version,
    reported_at: report.at, source: report.source,
    age_ms: age, stale: age === null || age >= DEVICE_STALE_MS };
}
// Absolute path: the vm test harness swaps `require`, so relative requires
// must never be used for project files.
const otaCore = require(path.join(__dirname, 'scripts', 'ota_core.js'));
const serialLogs = require(path.join(__dirname, 'scripts', 'serial_logs.js'));

// Never log or echo OTA_TOKEN anywhere. Tokens are compared as SHA-256 digests
// with a constant-time comparison, so even the comparison time leaks nothing.
function otaTokenMatches(provided) {
  return tokenMatches(OTA_TOKEN, provided);
}
function tokenMatches(secret, provided) {
  if (!secret || typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}
function ingestTokenMatches(req) {
  return tokenMatches(INGEST_TOKEN, req.headers['x-ingest-token'] || req.headers['x-api-key']);
}

function ip4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function otaSourceAllowed(addr) {
  let ip = String(addr || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  const n = ip4ToInt(ip);
  if (n === null) return false;
  return OTA_ALLOW_CIDRS.some(c => {
    const [net, bitsStr] = c.split('/');
    const base = ip4ToInt(net);
    if (base === null) return false;
    const bits = Number(bitsStr);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (base & mask) === (n & mask);
  });
}

function loadOtaManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(OTA_MANIFEST_FILE, 'utf8'));
    if (!m || typeof m !== 'object' || typeof m.enabled !== 'boolean') return null;
    if (typeof m.version !== 'string' || !OTA_SEMVER.test(m.version)) return null;
    if (m.path !== `/firmware/${m.version}/firmware.bin`) return null;
    return m;
  } catch { return null; } // missing or malformed manifest = feed disabled
}

// Active release info with on-disk truth: size and sha256 come from the actual
// binary (cached by version+size+mtime), never from the manifest alone.
const otaInfoCache = { version: null, size: -1, mtimeMs: -1, sha256: null };
function otaActiveInfo() {
  const m = loadOtaManifest();
  if (!m || m.enabled !== true) return { enabled: false, manifest: m };
  const binPath = path.join(OTA_DIR, 'releases', m.version, 'firmware.bin');
  let st;
  try { st = fs.statSync(binPath); } catch { return { enabled: false, manifest: m }; }
  if (!st.isFile() || st.size <= 0 || st.size > OTA_SIZE_CAP) return { enabled: false, manifest: m };
  if (otaInfoCache.version !== m.version || otaInfoCache.size !== st.size
      || otaInfoCache.mtimeMs !== st.mtimeMs) {
    otaInfoCache.version = m.version;
    otaInfoCache.size = st.size;
    otaInfoCache.mtimeMs = st.mtimeMs;
    otaInfoCache.sha256 = crypto.createHash('sha256').update(fs.readFileSync(binPath)).digest('hex');
  }
  return { enabled: true, manifest: m, size: st.size, sha256: otaInfoCache.sha256, binPath };
}

function handleOtaManifest(req, res) {
  if (!otaTokenMatches(req.headers['x-ota-token'])) return sendJSON(res, 401, { error: 'unauthorized' });
  if (!otaSourceAllowed(req.socket && req.socket.remoteAddress)) return sendJSON(res, 403, { error: 'forbidden' });
  recordDeviceVersion(otaVersionFromUA(req.headers['user-agent']), 'ota.user-agent');
  const info = otaActiveInfo();
  if (!info.enabled) {
    const body = JSON.stringify({ enabled: false });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }
  const body = JSON.stringify({
    enabled: true,
    version: info.manifest.version,
    project: info.manifest.project,
    chip: info.manifest.chip,
    layout: info.manifest.layout,
    size: info.size,
    sha256: info.sha256,
    path: info.manifest.path,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handleOtaBinary(req, res, pathname) {
  if (!otaTokenMatches(req.headers['x-ota-token'])) return sendJSON(res, 401, { error: 'unauthorized' });
  if (!otaSourceAllowed(req.socket && req.socket.remoteAddress)) return sendJSON(res, 403, { error: 'forbidden' });
  const info = otaActiveInfo();
  // Only the active release's exact URL is served; old releases stay on disk
  // for rollback via the publish CLI.
  if (!info.enabled || info.manifest.path !== pathname) {
    return sendJSON(res, 404, { error: 'firmware not available' });
  }
  // Track ESP32 download activity for the update-status panel.
  state.otaDownloads.count += 1;
  state.otaDownloads.last_at = Date.now();
  const uaVer = otaVersionFromUA(req.headers['user-agent']);
  if (uaVer) state.otaDownloads.last_ua_version = uaVer;
  recordDeviceVersion(uaVer, 'ota.user-agent');
  const buf = fs.readFileSync(info.binPath);
  // Exact Content-Length, no chunked transfer, no compression, no redirects.
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

// ---------------------------------------------------------------- OTA web flow
// The dashboard uploads a firmware.bin (raw body), the server validates it and
// STAGES it without touching the manifest; POST /api/ota/install then activates
// the staged release atomically. OTA_TOKEN is never involved here — it stays
// exclusively on the server for the ESP32's authenticated pull endpoints.

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, exceeded = false;
    req.on('data', c => {
      if (exceeded) return; // drain without buffering so an HTTP 413 can reach the client
      size += c.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.on('aborted', () => reject(new Error('request aborted')));
    req.on('error', reject);
  });
}

async function handleOtaUpload(req, res) {
  if (state.otaUploadBusy) return sendJSON(res, 429, { error: 'another upload is in progress' });
  state.otaUploadBusy = true;
  try {
    const buf = await readRawBody(req, OTA_UPLOAD_LIMIT);
    if (buf.length > OTA_SIZE_CAP) {
      return sendJSON(res, 413, { error: `firmware is ${buf.length} bytes — exceeds the 0x${OTA_SIZE_CAP.toString(16)} OTA cap` });
    }
    const validated = otaCore.validateApplicationImage(buf);
    if (!validated.ok) return sendJSON(res, 400, { error: validated.error });
    const meta = validated.meta;
    const staged = otaCore.stageRelease(OTA_DIR, meta.version, buf);
    if (!staged.ok) return sendJSON(res, 409, { error: staged.error });
    state.otaStaged = {
      version: meta.version,
      project: meta.project,
      size: staged.size,
      sha256: staged.sha256,
      staged_at: Date.now(),
    };
    const active = otaActiveInfo();
    return sendJSON(res, 200, {
      ok: true, staged: true,
      version: meta.version, project: meta.project, size: staged.size, sha256: staged.sha256,
      active_version: active.enabled ? active.manifest.version : null,
    });
  } catch (err) {
    if (err && err.status === 413) return sendJSON(res, 413, { error: `firmware exceeds the 0x${OTA_SIZE_CAP.toString(16)} OTA cap` });
    return sendJSON(res, 400, { error: String(err.message || err) });
  } finally {
    state.otaUploadBusy = false;
  }
}

async function handleOtaInstall(res, body) {
  const version = body && body.version;
  if (typeof version !== 'string' || !OTA_SEMVER.test(version)) {
    return sendJSON(res, 400, { error: 'version must be strict semver x.y.z' });
  }
  const binPath = path.join(OTA_DIR, 'releases', version, 'firmware.bin');
  let bin;
  try { bin = fs.readFileSync(binPath); }
  catch { return sendJSON(res, 404, { error: `release ${version} is not staged — upload its firmware.bin first` }); }

  const active = otaActiveInfo();
  if (active.enabled && otaCore.compareVersions(version, active.manifest.version) <= 0) {
    return sendJSON(res, 409, {
      error: `version ${version} is not newer than the active release ${active.manifest.version}`,
    });
  }

  const sha256 = otaCore.sha256hex(bin);
  const activated = otaCore.activateRelease(OTA_DIR, {
    enabled: true, version, project: OTA_PROJECT, chip: 'esp32s3',
    layout: OTA_LAYOUT, size: bin.length, sha256,
  });
  if (!activated.ok) return sendJSON(res, 500, { error: activated.error });
  state.otaStaged = null;
  return sendJSON(res, 200, { ok: true, active_version: version, size: bin.length, sha256 });
}

function otaStatusObject() {
  const info = otaActiveInfo();
  return {
    token_configured: Boolean(OTA_TOKEN),
    enabled: info.enabled,
    active_version: info.enabled ? info.manifest.version : null,
    active_published_at: info.enabled && info.manifest.published_at ? info.manifest.published_at : null,
    reported_version: state.otaReported.version,
    reported_at: state.otaReported.at,
    reported_source: state.otaReported.source,
    staged: state.otaStaged ? { ...state.otaStaged } : null,
    downloads: { ...state.otaDownloads },
    dir: OTA_DIR,
  };
}

const SIM_INTERVAL_MS = 1000;   // 1 sample / second
const SEC_MAX = 7200;           // keep 2 h of 1 s samples
const MIN_MAX = 10080;          // keep 7 d of 1 min aggregates
const MAX_BODY = 1024 * 1024;   // 1 MB JSON limit

const PHASES = ['l1', 'l2', 'l3'];
const PHASE_KEYS = ['vln', 'vln_min', 'vln_max', 'vln_avg', 'vll', 'vll_min',
  'vll_max', 'vll_avg', 'i', 'i_d', 'p', 'p_d', 'q', 'q_d', 's', 's_d',
  'pf', 'cphi', 'e_wh'];
const TOTAL_KEYS = ['vln_avg', 'vll_avg', 'i', 'p', 'q', 's', 'pf', 'e_wh', 'imbalance_p'];

// ---------------------------------------------------------------- state

const state = {
  startedAt: Date.now(),
  source: 'simulation',                 // effective: 'simulation' | 'device'
  sourceMode: 'auto',                   // 'auto' | 'device' | 'simulation'
  device: {
    connected: false, stale: false, last_seen: null, last_error: null,
    sequence: null, candidate_layout: null, adapter_connected: null,
    baudrate: null, device_id: null, register_count: null, start_address: null,
    age_ms: null, registers: null, feed: 'pull',
    has_sample: false, meter_error: null, last_sequence_at: null, last_sample_at: null,
  },
  deviceEnergy: { l1: 0, l2: 0, l3: 0 },
  prevDeviceP: { l1: 0, l2: 0, l3: 0 },
  lastDevicePush: 0,
  sequence: 0,
  otaReported: { version: null, at: null, source: null }, // last running-version report
  otaStaged: null,                            // uploaded, validated, not yet active
  otaDownloads: { count: 0, last_at: null },  // ESP32 firmware.bin fetches
  otaUploadBusy: false,
  sim: { running: true, multiplier: 1, noise: 1 },
  sec: [],                              // 1 s samples (latest last)
  min: [],                              // 1 min aggregates
  minuteTail: [],                       // samples of the current minute
  latest: null,
  events: { l1: null, l2: null, l3: null },
  walk: { l1: 0, l2: 0, l3: 0 },
  ema: { l1: { p: 1350, i: 6 }, l2: { p: 950, i: 4.5 }, l3: { p: 1150, i: 5.4 } },
  energyWh: { l1: 0, l2: 0, l3: 0 },
};

const BASE = {
  l1: { p: 1250, i: 5.8, voff: 1.1 },
  l2: { p: 1050, i: 4.9, voff: -0.6 },
  l3: { p: 1180, i: 5.5, voff: 0.4 },
};

// ---------------------------------------------------------------- database

// One row per sample, all measurements as flat columns (null = unavailable).
const SAMPLE_COLS = ['t', 'seq', 'source', 'feed', 'freq',
  ...PHASES.flatMap(ph => PHASE_KEYS.map(k => `${ph}_${k}`)),
  ...TOTAL_KEYS.map(k => `tot_${k}`)];
const INSERT_SQL = `INSERT INTO samples (${SAMPLE_COLS.join(',')}) VALUES (${SAMPLE_COLS.map(() => '?').join(',')})`;

// Column → aggregate rule for minute/hour rollups (same semantics as aggregate()).
function aggExpr(col) {
  if (col === 't') return '(t / ?) * ?';
  if (col.endsWith('_min')) return `MIN(${col})`;
  if (col.endsWith('_max')) return `MAX(${col})`;
  if (col === 'seq' || col === 'source' || col === 'feed') return `MAX(${col})`; // keep text/identity, not AVG
  return `AVG(${col})`; // freq, plain metrics and e_wh (monotonic → AVG ok for rollups)
}

let db = null;        // DatabaseSync instance, null if storage failed to open
let insertStmt = null;

function openDatabase() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(`CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${SAMPLE_COLS.map(c => `${c} ${c === 't' || c === 'seq' ? 'INTEGER' : 'REAL'}`).join(',\n      ')}
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_samples_t ON samples(t);');
    db.exec(`CREATE TABLE IF NOT EXISTS device_firmware (
      device_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      reported_at INTEGER NOT NULL,
      source TEXT NOT NULL
    );`);
    const report = db.prepare('SELECT version, reported_at, source FROM device_firmware WHERE device_id = ?')
      .get(ESP32_DEVICE_ID);
    if (report && validFirmwareVersion(report.version) && Number.isFinite(report.reported_at)) {
      state.otaReported = { version: report.version, at: report.reported_at, source: report.source };
    }
    serialLogs.initDatabase(db);
    insertStmt = db.prepare(INSERT_SQL);
    console.log(`  db:      ${DB_PATH}`);
    return true;
  } catch (err) {
    console.error(`  db:      FAILED to open ${DB_PATH}: ${err.message} — running without persistence`);
    db = null;
    insertStmt = null;
    return false;
  }
}

function sampleToRow(s) {
  const row = [s.t, Number.isInteger(s.seq) ? s.seq : null,
    state.source, state.source === 'device' ? state.device.feed : null,
    Number.isFinite(s.freq) ? s.freq : null];
  for (const ph of PHASES) for (const k of PHASE_KEYS) {
    const v = s[ph][k];
    row.push(Number.isFinite(v) ? v : null);
  }
  for (const k of TOTAL_KEYS) {
    const v = s.tot[k];
    row.push(Number.isFinite(v) ? v : null);
  }
  return row;
}

function rowToSample(r) {
  const s = { t: r.t, seq: r.seq, freq: r.freq, l1: {}, l2: {}, l3: {}, tot: {} };
  for (const ph of PHASES) for (const k of PHASE_KEYS) s[ph][k] = r[`${ph}_${k}`] ?? null;
  for (const k of TOTAL_KEYS) s.tot[k] = r[`tot_${k}`] ?? null;
  return s;
}

function dbInsert(s) {
  if (!insertStmt) return;
  try { insertStmt.run(...sampleToRow(s)); }
  catch (err) { console.error(`db insert failed: ${err.message}`); }
}

function dbStats() {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT COUNT(*) AS n, MIN(t) AS oldest, MAX(t) AS newest FROM samples').get();
    const size = fs.statSync(DB_PATH).size;
    return { rows: row.n, size_bytes: size, oldest_t: row.oldest, newest_t: row.newest, path: DB_PATH };
  } catch { return null; }
}

// Load persisted history into the in-memory buffers so a restart keeps
// the live charts (2 h seconds + 7 d minute aggregates).
function loadHistoryFromDb() {
  if (!db) return;
  try {
    const secRows = db.prepare(`SELECT * FROM samples ORDER BY id DESC LIMIT ?`).all(SEC_MAX);
    secRows.reverse().forEach(r => state.sec.push(rowToSample(r)));
    const cutoff = Date.now() - 7 * 86400e3;
    const bucketMs = 60000;
    const aggCols = SAMPLE_COLS.filter(c => c !== 't')
      .map(c => `${aggExpr(c)} AS ${c}`).join(', ');
    const sql = `SELECT (t / ${bucketMs}) * ${bucketMs} AS t, ${aggCols}
                 FROM samples WHERE t >= ? GROUP BY 1 ORDER BY 1`;
    const minRows = db.prepare(sql).all(cutoff);
    minRows.forEach(r => state.min.push(rowToSample(r)));
    if (state.sec.length) {
      state.latest = state.sec[state.sec.length - 1];
      state.sequence = state.latest.seq || 0;
    }
    console.log(`  db:      loaded ${state.sec.length} s + ${state.min.length} min samples into buffers`);
  } catch (err) {
    console.error(`db history load failed: ${err.message}`);
  }
}

function applyRetention() {
  if (!db || DB_RETENTION_DAYS <= 0) return;
  const cutoff = Date.now() - DB_RETENTION_DAYS * 86400e3;
  try {
    const { changes } = db.prepare('DELETE FROM samples WHERE t < ?').run(cutoff);
    if (changes) console.log(`db retention: deleted ${changes} samples older than ${DB_RETENTION_DAYS} days`);
  } catch (err) { console.error(`db retention failed: ${err.message}`); }
}

// ---------------------------------------------------------------- helpers

function gauss() { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const rnd = (a, b) => a + Math.random() * (b - a);

function diurnalFactor(now) {
  const h = new Date(now).getHours() + new Date(now).getMinutes() / 60;
  return 0.72 + 0.28 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- simulator

function rollingStats(phase, key) {
  const tail = state.minuteTail;
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (const s of tail) {
    const v = s[phase][key];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; n++;
  }
  return { min, max, avg: sum / n };
}

function makeSample(now) {
  const t = (now / 1000);
  const s = { t: now, seq: ++state.sequence, freq: null, l1: {}, l2: {}, l3: {}, tot: {} };
  const mult = state.sim.multiplier;
  const noise = state.sim.noise;
  const diurnal = diurnalFactor(now);
  s.freq = 50 + 0.02 * Math.sin(t / 70) + gauss() * 0.004 * noise;

  for (const ph of PHASES) {
    const b = BASE[ph];
    // occasionally spawn or end load events
    const ev = state.events[ph];
    if (ev && now >= ev.until) state.events[ph] = null;
    if (!state.events[ph] && Math.random() < 1 / 900) {
      state.events[ph] = { factor: rnd(0.88, 1.18), until: now + rnd(45, 600) * 1000 };
    }
    const evFactor = state.events[ph] ? state.events[ph].factor : 1;
    // slow random walk of the load
    state.walk[ph] = clamp(state.walk[ph] * 0.995 + gauss() * 0.015 * noise, -0.12, 0.12);
    const loadFactor = clamp((1 + state.walk[ph]) * evFactor, 0.75, 1.3);

    const vln = 230 + b.voff + 1.2 * Math.sin(t / 90 + PHASES.indexOf(ph)) + gauss() * 0.25 * noise;
    const vll = vln * Math.sqrt(3);
    const pf = clamp(0.9 + 0.035 * Math.sin(t / 220 + PHASES.indexOf(ph) * 2) + gauss() * 0.006 * noise, 0.82, 0.98);
    const p = Math.max(40, b.p * mult * diurnal * loadFactor * (1 + gauss() * 0.02 * noise));
    const i = p / (vln * pf);
    const q = p * Math.tan(Math.acos(pf));
    const s2 = p / pf;

    state.ema[ph].p = state.ema[ph].p * 0.998 + p * 0.002;
    state.ema[ph].i = state.ema[ph].i * 0.998 + i * 0.002;
    state.energyWh[ph] += (p * SIM_INTERVAL_MS) / 3600000;

    const vlnSt = rollingStats(ph, 'vln');
    const vllSt = rollingStats(ph, 'vll');
    const pSt = rollingStats(ph, 'p');
    const iSt = rollingStats(ph, 'i');

    s[ph] = {
      vln, vln_min: vlnSt.min, vln_max: vlnSt.max, vln_avg: vlnSt.avg,
      vll, vll_min: vllSt.min, vll_max: vllSt.max, vll_avg: vllSt.avg,
      i, i_d: state.ema[ph].i,
      p, p_d: state.ema[ph].p,
      q, q_d: state.ema[ph].q = state.ema[ph].q !== undefined ? state.ema[ph].q * 0.998 + q * 0.002 : q,
      s: s2, s_d: state.ema[ph].s = state.ema[ph].s !== undefined ? state.ema[ph].s * 0.998 + s2 * 0.002 : s2,
      pf, cphi: pf,
      freq: s.freq,
      e_wh: state.energyWh[ph],
    };
  }

  const sum = k => PHASES.reduce((a, ph) => a + s[ph][k], 0);
  const p1 = s.l1.p, p2 = s.l2.p, p3 = s.l3.p;
  const pMean = (p1 + p2 + p3) / 3;
  s.tot = {
    vln_avg: (s.l1.vln + s.l2.vln + s.l3.vln) / 3,
    vll_avg: (s.l1.vll + s.l2.vll + s.l3.vll) / 3,
    i: sum('i'),
    p: sum('p'), q: sum('q'), s: sum('s'),
    pf: sum('p') / sum('s'),
    e_wh: state.energyWh.l1 + state.energyWh.l2 + state.energyWh.l3,
    imbalance_p: pMean > 0 ? (Math.max(p1, p2, p3) - Math.min(p1, p2, p3)) / pMean * 100 : 0,
  };
  return s;
}

function aggregate(samples) {
  if (!samples.length) return null;
  const finiteVals = vals => vals.filter(v => typeof v === 'number' && Number.isFinite(v));
  const out = { t: samples[samples.length - 1].t, seq: samples[samples.length - 1].seq, freq: null, l1: {}, l2: {}, l3: {}, tot: {} };
  for (const ph of PHASES) {
    for (const key of PHASE_KEYS) {
      const vals = finiteVals(samples.map(s => s[ph][key]));
      if (!vals.length) { out[ph][key] = null; continue; }
      if (key === 'e_wh') out[ph][key] = vals[vals.length - 1];
      else if (key.endsWith('_min')) out[ph][key] = Math.min(...vals);
      else if (key.endsWith('_max')) out[ph][key] = Math.max(...vals);
      else out[ph][key] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  }
  for (const key of TOTAL_KEYS) {
    const vals = finiteVals(samples.map(s => s.tot[key]));
    if (!vals.length) { out.tot[key] = null; continue; }
    if (key === 'e_wh') out.tot[key] = vals[vals.length - 1];
    else out.tot[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const freqs = finiteVals(samples.map(s => s.freq));
  out.freq = freqs.length ? freqs.reduce((a, b) => a + b, 0) / freqs.length : null;
  return out;
}

function pushSample(s) {
  state.latest = s;
  state.minuteTail.push(s);
  state.sec.push(s);
  if (state.sec.length > SEC_MAX) state.sec.shift();
  if (state.minuteTail.length >= 60) {
    state.min.push(aggregate(state.minuteTail));
    state.minuteTail = [];
    if (state.min.length > MIN_MAX) state.min.shift();
  }
  dbInsert(s);
}

function tick() {
  if (!state.sim.running || state.source !== 'simulation') return;
  pushSample(makeSample(Date.now()));
}

// ---------------------------------------------------------------- ESP32 source

const DEVICE_GROUP_MAP = {
  vln: 'voltage_ln', vln_min: 'voltage_ln_min', vln_max: 'voltage_ln_max', vln_avg: 'voltage_ln_avg',
  vll: 'voltage_ll', vll_min: 'voltage_ll_min', vll_max: 'voltage_ll_max', vll_avg: 'voltage_ll_avg',
  i: 'current', i_d: 'current_demand',
  p: 'active_power', p_d: 'active_power_demand',
  q: 'reactive_power', q_d: 'reactive_power_demand',
  s: 'apparent_power', s_d: 'apparent_power_demand',
  pf: 'power_factor', cphi: 'cos_phi',
};

function parseEsp32Sample(meter, receivedAt) {
  if (!meter || meter.has_sample !== true) return null;
  const gmap = new Map();
  for (const g of Array.isArray(meter.groups) ? meter.groups : []) {
    if (g && typeof g.key === 'string' && Array.isArray(g.values)) gmap.set(g.key, g.values);
  }
  const gv = (key, idx) => {
    const vals = gmap.get(key);
    if (!vals || !vals.length) return null;
    const v = vals.length === 1 ? vals[0] : vals[idx];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const POWER_KEYS = new Set(['p', 'p_d', 'q', 'q_d', 's', 's_d']);
  const s = { t: receivedAt,
    seq: Number.isInteger(meter.sequence) ? meter.sequence : 0,
    freq: null, l1: {}, l2: {}, l3: {}, tot: {} };
  const freqVals = [];
  for (const [idx, ph] of PHASES.entries()) {
    for (const [outKey, devKey] of Object.entries(DEVICE_GROUP_MAP)) {
      let v = gv(devKey, idx);
      // The meter's power registers are in kW (demand block: 20 A × 220 V =
      // 4.4 kW). Scale to W so integration and formatters stay correct.
      if (v !== null && POWER_KEYS.has(outKey)) v *= 1000;
      s[ph][outKey] = v;
    }
    const f = gv('frequency', idx);
    s[ph].freq = f !== null && f > 0 ? f : null;   // 0 = no voltage inputs
    if (s[ph].freq !== null) freqVals.push(s[ph].freq);
    s[ph].e_wh = 0; // filled by server-side integration below
  }
  s.freq = freqVals.length
    ? freqVals.reduce((a, b) => a + b, 0) / freqVals.length : null;
  // Energy: the meter's energy registers are not decoded yet, so integrate
  // active power on the server. Never integrate across a communication outage.
  const gap = receivedAt - state.lastDevicePush;
  const dt = state.lastDevicePush && gap < DEVICE_STALE_MS ? Math.max(0, gap / 1000) : 0;
  for (const ph of PHASES) {
    const p = s[ph].p, prev = state.prevDeviceP[ph];
    // Import energy never decreases; exporting phases (negative p) freeze it.
    // The meter's export counters are outside the ESP32's 114-word window.
    state.deviceEnergy[ph] = Math.max(0,
      state.deviceEnergy[ph] + ((p === null ? 0 : p) + (prev === null ? 0 : prev)) / 2 * dt / 3600);
    s[ph].e_wh = state.deviceEnergy[ph];
    state.prevDeviceP[ph] = p;
  }
  state.lastDevicePush = receivedAt;
  const sum = k => PHASES.reduce((a, ph) => a + (Number.isFinite(s[ph][k]) ? s[ph][k] : 0), 0);
  const pSum = sum('p'), sSum = sum('s'), pDSum = sum('p_d');
  const avgVln = PHASES.map(ph => s[ph].vln).filter(Number.isFinite);
  const avgVll = PHASES.map(ph => s[ph].vll).filter(Number.isFinite);
  const pfRaw = sSum > 0 ? pSum / sSum : null;
  // Imbalance is only meaningful under real load: suppress while live power is
  // negligible relative to the demand registers (idle noise otherwise).
  const loadMeaningful = pSum > 1e-6 && (pDSum <= 0 || pSum >= pDSum * 0.01);
  s.tot = {
    vln_avg: avgVln.length ? avgVln.reduce((a, b) => a + b, 0) / avgVln.length : null,
    vll_avg: avgVll.length ? avgVll.reduce((a, b) => a + b, 0) / avgVll.length : null,
    i: sum('i'), p: pSum, q: sum('q'), s: sSum,
    pf: pfRaw === null ? null : clamp(pfRaw, -1, 1),
    e_wh: state.deviceEnergy.l1 + state.deviceEnergy.l2 + state.deviceEnergy.l3,
    imbalance_p: loadMeaningful
      ? (Math.max(s.l1.p, s.l2.p, s.l3.p) - Math.min(s.l1.p, s.l2.p, s.l3.p)) / (pSum / 3) * 100
      : null,
  };
  return s;
}

function clearHistory() {
  state.sec = []; state.min = []; state.minuteTail = []; state.latest = null; state.sequence = 0;
}

function switchToDevice(sample) {
  clearHistory();
  state.deviceEnergy = { l1: 0, l2: 0, l3: 0 };
  state.prevDeviceP = { l1: 0, l2: 0, l3: 0 };
  state.lastDevicePush = 0;
  state.source = 'device';
  state.sim.running = false;
  if (sample) pushSample(sample);
}

function pushDeviceSample(s, meter) {
  if (state.latest && state.latest.seq === s.seq) return; // no new sample
  if (state.source !== 'device') switchToDevice(s);
  else pushSample(s);
}

// Shared by the pull poller (server → ESP32) and the push ingest endpoint
// (ESP32 → server): updates device status, parses the native meter payload
// and feeds the history buffers.
function ingestMeterPayload(meter, receivedAt, feed) {
  if (deviceStatus(receivedAt).stale) state.lastDevicePush = 0;
  if (meter.has_sample === true && (state.device.last_sequence_at === null
      || !Number.isInteger(meter.sequence) || meter.sequence !== state.device.sequence)) {
    state.device.last_sequence_at = receivedAt;
  }
  state.device.connected = true;
  state.device.last_seen = receivedAt;
  state.device.last_error = null;
  state.device.stale = meter.stale === true;
  state.device.has_sample = meter.has_sample === true;
  state.device.meter_error = meter.last_error == null || meter.last_error === ''
    ? null : String(meter.last_error);
  state.device.sequence = Number.isInteger(meter.sequence) ? meter.sequence : null;
  state.device.candidate_layout = meter.candidate_layout === true;
  state.device.adapter_connected = typeof meter.adapter_connected === 'boolean' ? meter.adapter_connected : null;
  state.device.baudrate = Number.isFinite(meter.baudrate) ? meter.baudrate : null;
  state.device.device_id = Number.isInteger(meter.device_id) ? meter.device_id : null;
  state.device.register_count = Array.isArray(meter.registers) ? meter.registers.length : null;
  state.device.start_address = Number.isInteger(meter.start_address) ? meter.start_address : null;
  state.device.age_ms = Number.isFinite(meter.age_ms) ? meter.age_ms : null;
  state.device.registers = Array.isArray(meter.registers) ? meter.registers.slice() : null;
  state.device.feed = feed;
  // First contact, even a fault report, must not leave simulated values on screen.
  if (state.sourceMode === 'auto' && state.source !== 'device') switchToDevice();
  if (deviceStatus(receivedAt).stale) { state.lastDevicePush = 0; return; }
  if (state.source === 'device' && state.latest && Number.isInteger(meter.sequence)
      && state.latest.seq === meter.sequence) return;
  const sample = parseEsp32Sample(meter, receivedAt);
  if (sample) {
    state.device.last_sample_at = receivedAt - Math.max(0, state.device.age_ms || 0);
    if (state.source === 'device') pushDeviceSample(sample);
    else if (state.sourceMode === 'auto') switchToDevice(sample); // first real sample
    // explicit 'simulation' mode: report status only, keep simulating
  }
}

let deviceBusy = false;
async function pollEsp32() {
  if (deviceBusy) return;
  deviceBusy = true;
  try {
    const res = await fetch(ESP32_URL, {
      signal: AbortSignal.timeout(ESP32_TIMEOUT_MS),
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`ESP32 returned HTTP ${res.status}`);
    const data = await res.json();
    const meter = data && typeof data === 'object' ? data.meter : null;
    if (!meter || typeof meter !== 'object') throw new Error('ESP32 payload has no meter object');
    // Trust only the response to our configured device poll, not arbitrary
    // inbound requests. Capture envelope metadata before projecting the meter.
    recordDeviceVersion(data.firmware_version, 'lan.json');
    // Once the ESP32 pushes, push stays the reported feed (LAN pull keeps
    // working silently as a second transport, but must not flicker status).
    ingestMeterPayload(meter, Date.now(), state.device.feed === 'push' ? 'push' : 'pull');
  } catch (err) {
    // Keep the last successful contact and meter state during a missed poll.
    // deviceStatus expires contact by age; a single failure is not an outage.
    // In push mode LAN pull failures are expected and are not its diagnostics.
    if (state.device.feed !== 'push') {
      state.device.last_error = String(err && err.message ? err.message : err);
    }
  } finally {
    deviceBusy = false;
  }
}

// ---------------------------------------------------------------- history

const HISTORY_RANGE_MS = {
  '1m': 60000, '5m': 300000, live: 600000, '15m': 900000,
  '30m': 1800000, '1h': 3600000, '6h': 21600000, '24h': 86400000,
  '7d': 604800000, '30d': 2592000000, '90d': 7776000000,
  '180d': 15552000000, '1y': 31536000000, '2y': 63072000000,
  '5y': 157680000000,
};

const HISTORY_MAX_POINTS = 720;
const HISTORY_CACHE_MS = 15000;
const HISTORY_CACHE_MAX = 32;
const historyCache = new Map();

function historyBucketMs(span) {
  const resolution = span <= HISTORY_RANGE_MS['1h'] ? 1000 : 60000;
  // Epoch-aligned inclusive windows can touch one extra bucket at an edge.
  return Math.ceil(span / (HISTORY_MAX_POINTS - 1) / resolution) * resolution;
}

function historySqlitePoints(source, from, to, bucketMs) {
  const counters = SAMPLE_COLS.filter(c => c.endsWith('_e_wh'));
  const cols = SAMPLE_COLS.filter(c => c !== 't' && !counters.includes(c))
    .map(c => `${aggExpr(c)} AS ${c}`).join(', ');
  const args = [source, from, to];
  const energy = counters.map(c => {
    args.push(source, from, to);
    // Counters can reset, so neither AVG nor MAX is a real recorded value.
    // Index-bounded lookups also preserve a wholly unavailable counter as null.
    return `(SELECT e.${c} FROM samples e WHERE e.source = ?
      AND e.t >= MAX(?, buckets.bucket * ${bucketMs})
      AND e.t <= MIN(?, (buckets.bucket + 1) * ${bucketMs} - 1)
      AND e.${c} IS NOT NULL ORDER BY e.t DESC, e.id DESC LIMIT 1) AS ${c}`;
  }).join(', ');
  return db.prepare(`WITH buckets AS (
    SELECT CAST(t / ${bucketMs} AS INTEGER) AS bucket, MAX(t) AS t, ${cols}
    FROM samples WHERE source = ? AND t >= ? AND t <= ? GROUP BY bucket
  ) SELECT buckets.*, ${energy} FROM buckets ORDER BY t LIMIT ${HISTORY_MAX_POINTS}`)
    .all(...args).map(rowToSample);
}

function historySqliteRange(source, range, from, to, bucketMs) {
  const first = Math.floor(from / bucketMs), last = Math.floor(to / bucketMs);
  const middleFrom = (first + 1) * bucketMs, middleTo = last * bucketMs - 1;
  const key = `${source}\0${range}`;
  for (const [k, value] of historyCache) {
    if (to < value.at || to - value.at >= HISTORY_CACHE_MS) historyCache.delete(k);
  }
  let cached = historyCache.get(key);
  if (!cached || cached.db !== db || cached.from !== middleFrom || cached.to !== middleTo) {
    cached = {
      db, at: to, from: middleFrom, to: middleTo,
      points: middleFrom <= middleTo ? historySqlitePoints(source, middleFrom, middleTo, bucketMs) : [],
      oldest: db.prepare('SELECT t FROM samples WHERE source = ? ORDER BY t LIMIT 1').get(source)?.t ?? null,
    };
  }
  // Only whole interior buckets are cached. Re-query both clipped edges so a
  // rolling cutoff never reuses expired samples and the current minute is live.
  const leading = historySqlitePoints(source, from, Math.min(to, middleFrom - 1), bucketMs);
  const trailing = first === last ? [] : historySqlitePoints(source, last * bucketMs, to, bucketMs);
  const points = [...leading, ...cached.points, ...trailing];
  const oldest = [cached.oldest, ...points.map(p => p.t)].filter(Number.isFinite);
  cached.oldest = oldest.length ? Math.min(...oldest) : null;
  historyCache.delete(key);
  historyCache.set(key, cached);
  while (historyCache.size > HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value);
  return { points, partial: cached.oldest === null || cached.oldest > from };
}

function historyMemoryPoints(from, to, bucketMs) {
  // Boot-loaded buffers have no source provenance (and their minute values
  // may combine sources). On storage failure conservatively use this session
  // only, rather than presenting those rows as the currently selected source.
  const inRange = s => Number.isFinite(s.t) && s.t >= Math.max(from, state.startedAt) && s.t <= to;
  const raw = [...new Set([...state.sec.slice(-SEC_MAX), ...state.minuteTail.slice(-60)])]
    .filter(inRange).sort((a, b) => a.t - b.t);
  const firstRaw = raw.length ? raw[0].t : Infinity;
  const older = state.min.slice(-MIN_MAX).filter(s => inRange(s) && s.t < firstRaw);
  const buckets = new Map();
  for (const s of [...older, ...raw].sort((a, b) => a.t - b.t)) {
    const bucket = Math.floor(s.t / bucketMs);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(s);
  }
  return [...buckets.values()].map(aggregate);
}

function historyFor(range, now = Date.now()) {
  if (!Object.hasOwn(HISTORY_RANGE_MS, range)) throw new Error('unknown history range');
  const span = HISTORY_RANGE_MS[range];
  const from = now - span;
  const bounds = { unit: span <= HISTORY_RANGE_MS['1h'] ? 's' : 'min',
    from, to: now, span_ms: span };
  let warning = 'SQLite history unavailable; showing only available in-memory samples.';
  if (db) {
    try {
      const result = historySqliteRange(state.source, range, from, now, historyBucketMs(span));
      return { ...bounds, storage: 'sqlite', ...result };
    } catch {
      historyCache.delete(`${state.source}\0${range}`);
      warning = 'SQLite history query failed; showing only available in-memory samples.';
    }
  }
  return {
    ...bounds, storage: 'memory', partial: true, warning,
    points: historyMemoryPoints(from, now, historyBucketMs(span)),
  };
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendJSON(res, code, obj) { send(res, code, JSON.stringify(obj)); }

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? INDEX_FILE : path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== INDEX_FILE) {
    return sendJSON(res, 403, { error: 'forbidden' });
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      if (pathname === '/' ) return send(res, 500, 'index.html missing', 'text/plain');
      return sendJSON(res, 404, { error: 'not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => sendJSON(res, 500, { error: 'read failed' }));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    stream.pipe(res);
  });
}

function deviceStatus(now = Date.now()) {
  const d = state.device;
  const age = d.last_seen === null ? null : Math.max(0, now - d.last_seen);
  const connected = d.connected && age !== null && age <= ESP32_CONNECTION_TIMEOUT_MS;
  const reportedAge = d.age_ms === null ? null : Math.max(0, d.age_ms) + (age || 0);
  const sequenceAge = d.last_sequence_at === null ? null : Math.max(0, now - d.last_sequence_at);
  const sampleAge = reportedAge === null && sequenceAge === null ? null
    : Math.max(reportedAge || 0, sequenceAge || 0);
  let health = !connected
    ? { code: age === null ? 'waiting' : 'esp32_offline', severity: 'error',
      message: age === null ? 'Waiting for ESP32 data.'
        : 'Communication lost with ESP32: no data received for more than 8 seconds. Check its power, Wi-Fi and network connection.' }
    : { code: 'ok', severity: 'ok', message: 'ESP32 connected; meter readings are live.' };
  if (connected && d.adapter_connected === false) {
    health = { code: 'adapter_disconnected', severity: 'error',
      message: 'ESP32 is online, but it reports the RS-485 adapter disconnected. Check the adapter connection and power.' };
  } else if (connected && d.meter_error) {
    health = { code: 'meter_error', severity: 'error',
      message: `ESP32 is online, but meter communication failed: ${d.meter_error}. Check RS-485 wiring, adapter and meter power.` };
  } else if (connected && !d.has_sample) {
    health = { code: 'meter_no_data', severity: 'warning',
      message: 'ESP32 is online, but no meter sample is available. Check the RS-485 connection and meter power.' };
  } else if (connected && (d.stale || sampleAge >= DEVICE_STALE_MS)) {
    health = { code: 'meter_stale', severity: 'warning',
      message: 'ESP32 is online, but meter readings are not updating. Check RS-485 wiring, adapter and meter power.' };
  }
  return { ...d, firmware: firmwareStatus(now), connected, stale: health.code !== 'ok',
    last_seen_age_ms: age, sample_age_ms: sampleAge, timeout_ms: ESP32_CONNECTION_TIMEOUT_MS, health };
}

function readingsPayload() {
  return {
    source: state.source,
    sample: state.latest,
    meta: {
      now: Date.now(),
      started_at: state.startedAt,
      source_mode: state.sourceMode,
      esp32_url: ESP32_URL,
      sim: { ...state.sim },
      buffers: { sec: state.sec.length, min: state.min.length },
      device: deviceStatus(),
      db: dbStats(),
      ota: otaStatusObject(),
    },
  };
}

async function handleSim(res, body) {
  if (typeof body.running === 'boolean') state.sim.running = body.running;
  if (Number.isFinite(body.multiplier)) state.sim.multiplier = clamp(body.multiplier, 0, 2);
  if (Number.isFinite(body.noise)) state.sim.noise = clamp(body.noise, 0, 2);
  if (body.spike === true) {
    for (const ph of PHASES) state.events[ph] = { factor: rnd(1.3, 1.6), until: Date.now() + 30000 };
  }
  sendJSON(res, 200, { ok: true, sim: { ...state.sim } });
}

async function handleSource(res, body) {
  const mode = body && body.mode;
  if (!['auto', 'device', 'simulation'].includes(mode)) {
    return sendJSON(res, 400, { error: 'mode must be one of: auto, device, simulation' });
  }
  state.sourceMode = mode;
  if (mode === 'device') {
    state.source = 'device';
    state.sim.running = false;
    clearHistory();
    state.deviceEnergy = { l1: 0, l2: 0, l3: 0 };
    state.prevDeviceP = { l1: 0, l2: 0, l3: 0 };
    state.lastDevicePush = 0;
  } else if (mode === 'simulation') {
    state.source = 'simulation';
    state.sim.running = true;
    clearHistory();
  } else { // auto: prefer the device if we saw it recently
    const fresh = state.device.connected && state.device.last_seen
      && Date.now() - state.device.last_seen < 30000;
    state.source = fresh ? 'device' : 'simulation';
    state.sim.running = !fresh;
    clearHistory();
  }
  sendJSON(res, 200, { ok: true, mode: state.sourceMode, source: state.source });
}

async function handleIngest(req, res, body) {
  if (INGEST_TOKEN && !ingestTokenMatches(req)) return sendJSON(res, 401, { error: 'invalid ingest token' });
  if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'invalid payload' });
  // Legacy readings may still be accepted without a configured token, but
  // unauthenticated requests must never mutate trusted firmware metadata.
  if (INGEST_TOKEN) {
    const inJSON = Object.hasOwn(body, 'firmware_version');
    recordDeviceVersion(inJSON ? body.firmware_version : req.headers['x-firmware-version'],
      inJSON ? 'ingest.json' : 'ingest.header');
  }
  // Native ESP32 payload — the exact JSON the ESP32 serves on /api/readings
  // ({meter:{groups,registers,...}, ...}). This is the shape the ESP32 pushes
  // over the tailnet.
  if (body.meter && typeof body.meter === 'object') {
    ingestMeterPayload(body.meter, Date.now(), 'push');
    return sendJSON(res, 200, { ok: true, feed: 'push', buffered: { sec: state.sec.length, min: state.min.length } });
  }
  // Legacy shapes: an internal sample directly, or a loose {phases:{l1:{...}}}.
  let s = body.sample && typeof body.sample === 'object' ? body.sample : null;
  if (!s && body.phases) {
    s = { t: Number(body.t) || Date.now(), seq: 0, freq: Number(body.freq) || 50, l1: {}, l2: {}, l3: {}, tot: {} };
    for (const ph of PHASES) {
      const src = body.phases[ph] || {};
      const p = Number(src.p) || 0, pf = Number(src.pf) || 1, vln = Number(src.vln) || 0;
      const i = Number(src.i) || (vln && pf ? p / (vln * pf) : 0);
      const q = Number(src.q) || (p * Math.tan(Math.acos(clamp(pf, 0.01, 1))));
      s[ph] = { vln, vln_min: vln, vln_max: vln, vln_avg: vln, vll: vln * Math.sqrt(3), vll_min: 0, vll_max: 0, vll_avg: 0, i, i_d: i, p, p_d: p, q, q_d: q, s: p / pf, s_d: p / pf, pf, cphi: pf, e_wh: Number(src.e_wh) || 0 };
    }
    const sum = k => PHASES.reduce((a, ph) => a + (s[ph][k] || 0), 0);
    s.tot = { vln_avg: sum('vln') / 3, vll_avg: sum('vll') / 3, i: sum('i'), p: sum('p'), q: sum('q'), s: sum('s'), pf: sum('p') / sum('s'), e_wh: sum('e_wh'), imbalance_p: 0 };
  }
  if (!s || !s.l1 || typeof s.l1.p !== 'number') return sendJSON(res, 400, { error: 'unrecognized sample shape' });
  state.device.connected = true;
  state.device.last_seen = Date.now();
  state.device.last_error = null;
  state.device.stale = false;
  state.device.has_sample = true;
  state.device.adapter_connected = null; // legacy payload has no adapter diagnostics
  state.device.meter_error = null;
  state.device.age_ms = 0;
  state.device.sequence = s.seq;
  state.device.last_sequence_at = state.device.last_seen;
  state.device.last_sample_at = state.device.last_seen;
  state.device.feed = 'push';
  if (state.source !== 'device') switchToDevice(s);
  else pushSample(s);
  sendJSON(res, 200, { ok: true, feed: 'push', buffered: { sec: state.sec.length, min: state.min.length } });
}

const EXPORT_RANGE_MS = {
  live: 10 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3,
  '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, all: Infinity,
};

function handleExport(res, url) {
  if (!db) return sendJSON(res, 503, { error: 'database unavailable' });
  const range = EXPORT_RANGE_MS[url.searchParams.get('range')] !== undefined
    ? url.searchParams.get('range') : '1h';
  let group = url.searchParams.get('group') || 'auto';
  if (group === 'auto') {
    group = ['live', '1h', '6h'].includes(range) ? 'raw' : range === '24h' ? 'minute' : 'hour';
  }
  if (!['raw', 'minute', 'hour'].includes(group)) {
    return sendJSON(res, 400, { error: 'group must be raw | minute | hour | auto' });
  }
  const cutoff = EXPORT_RANGE_MS[range] === Infinity ? 0 : Date.now() - EXPORT_RANGE_MS[range];
  let rows;
  try {
    if (group === 'raw') {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM samples WHERE t >= ?').get(cutoff);
      if (n > RAW_EXPORT_MAX_ROWS) {
        return sendJSON(res, 400, {
          error: `${n} raw samples in range (max ${RAW_EXPORT_MAX_ROWS}). Use group=minute or group=hour, or a smaller range.`,
        });
      }
      rows = db.prepare('SELECT * FROM samples WHERE t >= ? ORDER BY t').all(cutoff);
    } else {
      const bucketMs = group === 'minute' ? 60000 : 3600e3;
      const cols = SAMPLE_COLS.filter(c => c !== 't')
        .map(c => `${aggExpr(c)} AS ${c}`).join(', ');
      const sql = `SELECT (t / ${bucketMs}) * ${bucketMs} AS t, ${cols}
                   FROM samples WHERE t >= ? GROUP BY 1 ORDER BY 1`;
      rows = db.prepare(sql).all(cutoff);
    }
  } catch (err) {
    return sendJSON(res, 500, { error: `export query failed: ${err.message}` });
  }
  if (!rows.length) return sendJSON(res, 200, 't\n', 'text/csv; charset=utf-8');

  const header = ['t_iso', 't_ms', ...SAMPLE_COLS.slice(1)];
  const lines = [header.join(',')];
  for (const r of rows) {
    const iso = new Date(r.t).toISOString();
    lines.push([iso, r.t, ...SAMPLE_COLS.slice(1).map(c => {
      const v = r[c];
      return v === null || v === undefined ? '' : v;
    })].join(','));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="energymeter-${range}-${group}-${stamp}.csv"`,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(lines.join('\n') + '\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/status') {
      return sendJSON(res, 200, {
        source: state.source,
        source_mode: state.sourceMode,
        esp32_url: ESP32_URL,
        started_at: state.startedAt,
        uptime_s: Math.floor((Date.now() - state.startedAt) / 1000),
        sim: { ...state.sim },
        buffers: { sec: state.sec.length, min: state.min.length },
        latest_seq: state.sequence,
        device: deviceStatus(),
        db: dbStats(),
        ota: otaStatusObject(),
        ingest_endpoint: 'POST /api/ingest',
      });
    }
    if (req.method === 'GET' && p === '/api/readings') {
      return sendJSON(res, 200, readingsPayload());
    }
    if (req.method === 'GET' && p === '/api/history') {
      const range = url.searchParams.get('range') ?? 'live';
      const h = historyFor(range);
      return sendJSON(res, 200, { range, generated_at: h.to, ...h });
    }
    if (req.method === 'GET' && p === '/api/export') {
      return handleExport(res, url);
    }
    if (req.method === 'POST' && p === '/api/source') {
      return handleSource(res, await readBody(req, MAX_BODY));
    }
    if (req.method === 'POST' && p === '/api/sim') {
      return handleSim(res, await readBody(req, MAX_BODY));
    }
    if (req.method === 'POST' && p === '/api/ingest') {
      return handleIngest(req, res, await readBody(req, MAX_BODY));
    }
    if (req.method === 'POST' && p === '/api/serial-log') {
      return await serialLogs.post(req, res, { db, tokenMatches: otaTokenMatches,
        sourceAllowed: otaSourceAllowed, validFirmwareVersion, readRawBody });
    }
    if (req.method === 'GET' && p === '/api/serial-log') {
      return serialLogs.get(req, res, url, { db, sourceAllowed: otaSourceAllowed, defaultDevice: ESP32_DEVICE_ID });
    }
    // Legacy metadata-only compatibility route. Actual console batches must
    // use /api/serial-log; neither route is a meter sample.
    if (req.method === 'POST' && p === '/api/serial') {
      const authorized = ingestTokenMatches(req) || (otaTokenMatches(req.headers['x-ota-token'])
        && otaSourceAllowed(req.socket && req.socket.remoteAddress));
      if (!authorized) return sendJSON(res, 401, { error: 'unauthorized' });
      await readRawBody(req, 256 * 1024);
      recordDeviceVersion(req.headers['x-firmware-version'], 'serial.header');
      return sendJSON(res, 200, { ok: true, log_storage: false });
    }
    // OTA endpoints: private, pull-based firmware feed for the ESP32.
    if (req.method === 'GET' && p === '/api/firmware/manifest') {
      return handleOtaManifest(req, res);
    }
    if (req.method === 'GET' && p.startsWith('/firmware/')) {
      return handleOtaBinary(req, res, p);
    }
    // OTA web flow: upload stages, install activates (dashboard admin side).
    if (req.method === 'POST' && p === '/api/ota/upload') {
      return handleOtaUpload(req, res);
    }
    if (req.method === 'POST' && p === '/api/ota/install') {
      return handleOtaInstall(res, await readBody(req, MAX_BODY));
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, p);
    }
    sendJSON(res, 405, { error: 'method not allowed' });
  } catch (err) {
    sendJSON(res, 400, { error: String(err.message || err) });
  }
});

setInterval(tick, SIM_INTERVAL_MS);
openDatabase();
loadHistoryFromDb();
tick(); // first sample immediately so the UI never sees an empty state
applyRetention();
setInterval(applyRetention, 24 * 3600e3);
if (ESP32_URL) {
  setInterval(pollEsp32, ESP32_POLL_MS);
  pollEsp32();
} else {
  console.log('  source:  pull disabled (ESP32_URL empty) — push mode via POST /api/ingest');
}
// Communication health is evaluated on every status/readings request, so
// timeouts apply to both feeds without waiting for a separate watchdog tick.

server.listen(PORT, HOST, () => {
  const ifaces = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  console.log('TPM-04-100D Energy Analytics server');
  console.log(`  local:   http://localhost:${PORT}/`);
  for (const a of addrs) console.log(`  network: http://${a}:${PORT}/`);
  console.log(`  source:  ${state.source} (simulator) — ESP32 ingest at POST /api/ingest`);
});
