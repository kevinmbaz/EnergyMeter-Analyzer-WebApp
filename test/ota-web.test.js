'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SERVER = path.join(__dirname, '..', 'server.js');
const OTA_SIZE_CAP = 0x3f0000;

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'em-otaweb-')); }

// Syntactically valid ESP32-S3 application image with a real app descriptor:
// header (magic 0xE9, chip 0x0009) + app_desc at 0x30 (magic 0xABCD5432,
// version @ +16, project @ +48). Optional appended SHA-256 per header flag 0x17.
function makeBin(size = 8192, opts = {}) {
  const buf = Buffer.alloc(Math.max(size, 0x80));
  buf[0] = opts.magic ?? 0xE9;
  buf[1] = 1; // segment count
  buf.writeUInt32LE(0x40380000, 4); // entry point
  buf.writeUInt16LE(opts.chipId ?? 0x0009, 12);
  buf[0x17] = opts.hashAppended ? 1 : 0;
  buf.writeUInt32LE(0xABCD5432, 0x30); // app_desc magic
  buf.write(opts.version ?? '1.4.0', 0x40, 'utf8');  // version[32]
  buf.write(opts.project ?? 'EnergyAnalyzer', 0x60, 'utf8'); // project[32]
  if (opts.hashAppended) {
    const payload = buf.subarray(0, size - 32);
    const h = crypto.createHash('sha256').update(payload).digest();
    if (opts.badHash) h[0] ^= 0xff;
    h.copy(buf, size - 32);
  }
  return buf.subarray(0, size);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function serverHarness(env = {}) {
  let handler = null;
  const context = vm.createContext({
    require(name) {
      if (name === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '..'),
    process: { env: { ESP32_URL: '', DB_PATH: ':memory:',
      OTA_TOKEN: 'test-token', OTA_ALLOW_CIDRS: '100.64.0.0/10,127.0.0.1/32', ...env } },
    console: { log() {} }, Date, URL, AbortSignal, Buffer, TextEncoder, TextDecoder,
    fetch: () => new Promise(() => {}),
    setInterval() {},
  });
  vm.runInContext(fs.readFileSync(SERVER, 'utf8'), context);
  return {
    async request(method, url, opts = {}) {
      const chunks = [];
      const res = {
        _h: null, _s: 0,
        writeHead(code, headers) {
          res._s = code;
          res._h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k, String(v)]));
        },
        setHeader(k, v) { res._h = { ...res._h, [k]: v }; },
        write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
        end(data) { if (data !== undefined) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
      };
      const bodyBuf = opts.body === undefined ? Buffer.alloc(0)
        : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
      const req = {
        method, url,
        headers: Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
        socket: { remoteAddress: opts.ip || '127.0.0.1' },
        on(ev, cb) {
          if (ev === 'data' && bodyBuf.length) cb(bodyBuf);
          if (ev === 'end') cb();
          return this;
        },
        destroy() {},
      };
      await handler(req, res);
      return { status: res._s, headers: res._h || {}, body: Buffer.concat(chunks) };
    },
    async get(url, opts) { return this.request('GET', url, opts); },
    async getJSON(url, opts) { const r = await this.get(url, opts); return { status: r.status, headers: r.headers, body: JSON.parse(r.body.toString('utf8')) }; },
    async postJSON(url, body, opts = {}) {
      return this.request('POST', url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: JSON.stringify(body) });
    },
    async upload(bin, opts = {}) {
      return this.request('POST', '/api/ota/upload', {
        ...opts, headers: { 'Content-Type': 'application/octet-stream', ...(opts.headers || {}) }, body: bin,
      });
    },
  };
}

const AUTH = (h = {}) => ({ headers: { 'X-OTA-Token': 'test-token', ...h } });

// ---------------------------------------------------------------- upload

test('upload rejects images that fail validation', async () => {
  const cases = [
    ['bad magic', makeBin(8192, { magic: 0x00 })],
    ['wrong chip id', makeBin(8192, { chipId: 0x0000 })],
    ['wrong project', makeBin(8192, { project: 'OtherProject' })],
    ['non-semver version', makeBin(8192, { version: '1.4' })],
    ['missing app descriptor', (() => { const b = makeBin(8192); b.writeUInt32LE(0, 0x30); return b; })()],
    ['appended hash mismatch', makeBin(8192, { hashAppended: true, badHash: true })],
  ];
  for (const [name, bin] of cases) {
    const h = serverHarness({ OTA_DIR: tmpdir() });
    const r = await h.upload(bin);
    assert.notEqual(r.status, 200, `${name} must be rejected (got ${r.status})`);
    assert.ok(JSON.parse(r.body.toString()).error, name);
  }
});

test('oversize uploads are rejected with 413', async () => {
  const h = serverHarness({ OTA_DIR: tmpdir() });
  const r = await h.upload(makeBin(OTA_SIZE_CAP + 1));
  assert.equal(r.status, 413);
});

test('upload stages the release without touching the manifest', async () => {
  const otaDir = tmpdir();
  const h = serverHarness({ OTA_DIR: otaDir });
  const bin = makeBin(9000, { version: '1.4.0' });
  const r = await h.upload(bin);
  assert.equal(r.status, 200, r.body.toString());
  const d = JSON.parse(r.body.toString());
  assert.equal(d.ok, true);
  assert.equal(d.version, '1.4.0');
  assert.equal(d.project, 'EnergyAnalyzer');
  assert.equal(d.size, bin.length);
  assert.equal(d.sha256, sha256(bin));
  assert.equal(d.active_version, null);
  // staged on disk, but no manifest exists yet
  assert.ok(fs.existsSync(path.join(otaDir, 'releases', '1.4.0', 'firmware.bin')));
  assert.ok(!fs.existsSync(path.join(otaDir, 'manifest.json')));
  // device feed still reports disabled
  const m = await h.getJSON('/api/firmware/manifest', AUTH());
  assert.deepEqual(m.body, { enabled: false });
  // status exposes the staged release
  const s = await h.getJSON('/api/status');
  assert.equal(s.body.ota.staged.version, '1.4.0');
  assert.equal(s.body.ota.staged.sha256, sha256(bin));
});

test('upload is idempotent for identical bytes and refuses different bytes at the same version', async () => {
  const otaDir = tmpdir();
  const h = serverHarness({ OTA_DIR: otaDir });
  const bin = makeBin(9000, { version: '1.4.0' });
  assert.equal((await h.upload(bin)).status, 200);
  assert.equal((await h.upload(bin)).status, 200);
  const other = makeBin(10000, { version: '1.4.0' });
  const r = await h.upload(other);
  assert.equal(r.status, 409);
  assert.ok(JSON.parse(r.body.toString()).error.includes('immutable'));
});

// ---------------------------------------------------------------- install

test('install atomically activates the staged release and serves it', async () => {
  const otaDir = tmpdir();
  const h = serverHarness({ OTA_DIR: otaDir });
  const bin = makeBin(12000, { version: '1.4.0' });
  assert.equal((await h.upload(bin)).status, 200);
  const r = await h.postJSON('/api/ota/install', { version: '1.4.0' });
  assert.equal(r.status, 200, r.body.toString());
  const d = JSON.parse(r.body.toString());
  assert.equal(d.ok, true);
  assert.equal(d.active_version, '1.4.0');
  // manifest endpoint now serves the enabled release
  const m = await h.getJSON('/api/firmware/manifest', AUTH());
  assert.equal(m.status, 200);
  assert.equal(m.body.enabled, true);
  assert.equal(m.body.version, '1.4.0');
  assert.equal(m.body.project, 'EnergyAnalyzer');
  assert.equal(m.body.chip, 'esp32s3');
  assert.equal(m.body.layout, 'energymeter-ota-v1');
  assert.equal(m.body.size, bin.length);
  assert.equal(m.body.sha256, sha256(bin));
  assert.equal(m.body.path, '/firmware/1.4.0/firmware.bin');
  // binary download byte-for-byte
  const binRes = await h.get('/firmware/1.4.0/firmware.bin', AUTH());
  assert.equal(binRes.status, 200);
  assert.ok(binRes.body.equals(bin));
  assert.equal(binRes.headers['Content-Length'], String(bin.length));
  // staged cleared after activation
  const s = await h.getJSON('/api/status');
  assert.equal(s.body.ota.active_version, '1.4.0');
  assert.equal(s.body.ota.staged, null);
  // no tmp leftovers
  assert.deepEqual(fs.readdirSync(otaDir).filter(f => f.endsWith('.tmp')), []);
});

test('install refuses versions that are not staged or not newer than active', async () => {
  const otaDir = tmpdir();
  const h = serverHarness({ OTA_DIR: otaDir });
  const notStaged = await h.postJSON('/api/ota/install', { version: '9.9.9' });
  assert.equal(notStaged.status, 404);
  assert.equal((await h.upload(makeBin(9000, { version: '1.4.0' }))).status, 200);
  assert.equal((await h.postJSON('/api/ota/install', { version: '1.4.0' })).status, 200);
  assert.equal((await h.upload(makeBin(9000, { version: '1.3.9' }))).status, 200);
  const older = await h.postJSON('/api/ota/install', { version: '1.3.9' });
  assert.equal(older.status, 409);
  assert.ok(JSON.parse(older.body.toString()).error.includes('not newer'));
  // new release still activates over the old one
  assert.equal((await h.upload(makeBin(10000, { version: '1.4.1' }))).status, 200);
  assert.equal((await h.postJSON('/api/ota/install', { version: '1.4.1' })).status, 200);
  const s = await h.getJSON('/api/status');
  assert.equal(s.body.ota.active_version, '1.4.1');
});

test('device version reporting and download tracking feed the status', async () => {
  const otaDir = tmpdir();
  const h = serverHarness({ OTA_DIR: otaDir });
  const bin = makeBin(9000, { version: '1.4.0' });
  await h.upload(bin);
  await h.postJSON('/api/ota/install', { version: '1.4.0' });
  // old device reports 1.3.9 on the manifest request, then downloads
  const m = await h.getJSON('/api/firmware/manifest', AUTH({ 'User-Agent': 'EnergyAnalyzer-OTA/1.3.9 (esp32s3)' }));
  assert.equal(m.body.version, '1.4.0');
  assert.equal((await h.get('/firmware/1.4.0/firmware.bin', AUTH({ 'User-Agent': 'EnergyAnalyzer-OTA/1.3.9 (esp32s3)' }))).status, 200);
  const s = await h.getJSON('/api/status');
  assert.equal(s.body.ota.reported_version, '1.3.9');
  assert.equal(s.body.ota.downloads.count, 1);
  assert.ok(s.body.ota.downloads.last_at > 0);
  // device reboots on the new firmware and reports it
  await h.getJSON('/api/firmware/manifest', AUTH({ 'User-Agent': 'EnergyAnalyzer-OTA/1.4.0 (esp32s3)' }));
  const s2 = await h.getJSON('/api/status');
  assert.equal(s2.body.ota.reported_version, '1.4.0');
  assert.equal(s2.body.ota.reported_version, s2.body.ota.active_version);
});

test('ingest and dashboard stay available when OTA web flow is used', async () => {
  const h = serverHarness({ OTA_DIR: tmpdir() });
  const ing = await h.request('POST', '/api/ingest', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.notEqual(ing.status, 404);
  const s = await h.getJSON('/api/status');
  assert.equal(s.body.ota.token_configured, true);
});
