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

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

// ESP32 data source (phase 2)
const ESP32_URL = process.env.ESP32_URL || 'http://energymeter.local/api/readings';
const ESP32_POLL_MS = Math.max(1000, Number(process.env.ESP32_POLL_MS || 2000));
const ESP32_TIMEOUT_MS = Number(process.env.ESP32_TIMEOUT_MS || 4000);
// Optional shared secret for POST /api/ingest (header: X-Ingest-Token).
// Off by default; set when ingesting over a public network.
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';

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
  },
  deviceEnergy: { l1: 0, l2: 0, l3: 0 },
  prevDeviceP: { l1: 0, l2: 0, l3: 0 },
  lastDevicePush: 0,
  sequence: 0,
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
  const freqRaw = gv('frequency', 0);
  const s = {
    t: receivedAt,
    seq: Number.isInteger(meter.sequence) ? meter.sequence : 0,
    freq: freqRaw !== null && freqRaw > 0 ? freqRaw : null,   // 0 = no voltage inputs
    l1: {}, l2: {}, l3: {}, tot: {},
  };
  for (const [idx, ph] of PHASES.entries()) {
    for (const [outKey, devKey] of Object.entries(DEVICE_GROUP_MAP)) {
      s[ph][outKey] = gv(devKey, idx);
    }
    s[ph].e_wh = 0; // filled by server-side integration below
  }
  // Energy: the meter's energy registers are not decoded yet, so integrate
  // active power on the server (trapezoid, dt capped at 30 s across gaps).
  const dt = state.lastDevicePush ? clamp((receivedAt - state.lastDevicePush) / 1000, 0, 30) : 0;
  for (const ph of PHASES) {
    const p = s[ph].p, prev = state.prevDeviceP[ph];
    state.deviceEnergy[ph] += ((p === null ? 0 : p) + (prev === null ? 0 : prev)) / 2 * dt / 3600;
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
    pf: pfRaw === null ? null : clamp(pfRaw, 0, 1),
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
  pushSample(sample);
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
  state.device.connected = true;
  state.device.last_seen = receivedAt;
  state.device.last_error = null;
  state.device.stale = meter.stale === true || meter.last_error != null || meter.adapter_connected !== true;
  state.device.sequence = Number.isInteger(meter.sequence) ? meter.sequence : null;
  state.device.candidate_layout = meter.candidate_layout === true;
  state.device.adapter_connected = meter.adapter_connected === true;
  state.device.baudrate = Number.isFinite(meter.baudrate) ? meter.baudrate : null;
  state.device.device_id = Number.isInteger(meter.device_id) ? meter.device_id : null;
  state.device.register_count = Array.isArray(meter.registers) ? meter.registers.length : null;
  state.device.start_address = Number.isInteger(meter.start_address) ? meter.start_address : null;
  state.device.age_ms = Number.isFinite(meter.age_ms) ? meter.age_ms : null;
  state.device.registers = Array.isArray(meter.registers) ? meter.registers.slice() : null;
  state.device.feed = feed;
  const sample = parseEsp32Sample(meter, receivedAt);
  if (sample) {
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
    // Once the ESP32 pushes, push stays the reported feed (LAN pull keeps
    // working silently as a second transport, but must not flicker status).
    ingestMeterPayload(meter, Date.now(), state.device.feed === 'push' ? 'push' : 'pull');
  } catch (err) {
    // In push mode the ESP32 connects to us; poll failures are expected and
    // must not flip the device status to offline.
    if (state.device.feed !== 'push') {
      state.device.connected = false;
      state.device.last_error = String(err && err.message ? err.message : err);
      if (state.source === 'device') state.device.stale = true;
    }
  } finally {
    deviceBusy = false;
  }
}

// ---------------------------------------------------------------- history

function downsample(samples, maxPoints) {
  if (samples.length <= maxPoints) return samples;
  const size = Math.ceil(samples.length / maxPoints);
  const out = [];
  for (let i = 0; i < samples.length; i += size) {
    out.push(aggregate(samples.slice(i, i + size)));
  }
  return out;
}

function historyFor(range) {
  switch (range) {
    case 'live': return { unit: 's', points: state.sec.slice(-600) };
    case '1h': return { unit: 's', points: downsample(state.sec.slice(-3600), 600) };
    case '6h': return { unit: 'min', points: state.min.slice(-360) };
    case '24h': return { unit: 'min', points: downsample(state.min.slice(-1440), 720) };
    case '7d': return { unit: 'min', points: downsample(state.min.slice(-10080), 720) };
    default: return { unit: 's', points: state.sec.slice(-600) };
  }
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
      device: state.device,
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
  if (INGEST_TOKEN) {
    const provided = req.headers['x-ingest-token'] || req.headers['x-api-key'];
    if (provided !== INGEST_TOKEN) return sendJSON(res, 401, { error: 'invalid ingest token' });
  }
  if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'invalid payload' });
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
  state.device.feed = 'push';
  if (state.source !== 'device') switchToDevice(s);
  else pushSample(s);
  sendJSON(res, 200, { ok: true, feed: 'push', buffered: { sec: state.sec.length, min: state.min.length } });
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
        device: state.device,
        ingest_endpoint: 'POST /api/ingest',
      });
    }
    if (req.method === 'GET' && p === '/api/readings') {
      if (!state.latest) return sendJSON(res, 503, { error: 'no sample yet' });
      return sendJSON(res, 200, readingsPayload());
    }
    if (req.method === 'GET' && p === '/api/history') {
      const range = url.searchParams.get('range') || 'live';
      const h = historyFor(range);
      return sendJSON(res, 200, { range, unit: h.unit, generated_at: Date.now(), points: h.points });
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
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, p);
    }
    sendJSON(res, 405, { error: 'method not allowed' });
  } catch (err) {
    sendJSON(res, 400, { error: String(err.message || err) });
  }
});

setInterval(tick, SIM_INTERVAL_MS);
tick(); // first sample immediately so the UI never sees an empty state
if (ESP32_URL) {
  setInterval(pollEsp32, ESP32_POLL_MS);
  pollEsp32();
} else {
  console.log('  source:  pull disabled (ESP32_URL empty) — push mode via POST /api/ingest');
}
// Push-mode watchdog: if the ESP32 stops pushing (link down, no WiFi, crash),
// mark readings stale instead of leaving "connected" with frozen values.
setInterval(() => {
  if (state.device.feed === 'push' && state.source === 'device'
      && state.device.last_seen && Date.now() - state.device.last_seen > 15000) {
    state.device.stale = true;
  }
}, 5000);

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
