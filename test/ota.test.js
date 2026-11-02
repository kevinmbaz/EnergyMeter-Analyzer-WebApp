'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const CLI = path.join(__dirname, '..', 'scripts', 'publish_ota.js');
const OTA_SIZE_CAP = 0x3f0000;

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'em-ota-')); }

// Minimal syntactically valid ESP32-S3 application image header + payload.
function makeBin(size = 4096, chipId = 0x0009, magic = 0xE9) {
  const buf = Buffer.alloc(Math.max(size, 0x18));
  buf[0] = magic;        // esp_image_header_t magic
  buf[1] = 1;            // segment count
  buf.writeUInt32LE(0x40380000, 4); // entry point
  buf.writeUInt16LE(chipId, 12);
  for (let i = 0x18; i + 4 <= buf.length; i += 4) buf.writeUInt32LE(i, i);
  return buf.subarray(0, size);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// Writes a release + active manifest directly (endpoint-level tests).
function publishFixture(otaDir, { version = '1.3.1', enabled = true, bin = makeBin() } = {}) {
  const relDir = path.join(otaDir, 'releases', version);
  fs.mkdirSync(relDir, { recursive: true });
  const binPath = path.join(relDir, 'firmware.bin');
  fs.writeFileSync(binPath, bin);
  const manifest = {
    enabled, version, project: 'EnergyAnalyzer', chip: 'esp32s3',
    layout: 'energymeter-ota-v1', size: bin.length, sha256: sha256(bin),
    path: `/firmware/${version}/firmware.bin`, published_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(otaDir, 'manifest.json'), JSON.stringify(manifest));
  return { bin, manifest };
}

function serverHarness(env = {}) {
  let handler = null;
  const context = vm.createContext({
    require(name) {
      if (name === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '..'),
    process: { env: { ESP32_URL: '', DB_PATH: ':memory:',
      OTA_ALLOW_CIDRS: '100.64.0.0/10,127.0.0.1/32', ...env } },
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
          // Node stringifies header values on the wire; mirror that.
          res._h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k, String(v)]));
        },
        setHeader(k, v) { res._h = { ...res._h, [k]: v }; },
        write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
        end(data) { if (data !== undefined) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
      };
      const req = {
        method, url,
        headers: Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
        socket: { remoteAddress: opts.ip || '100.72.135.8' },
      };
      await handler(req, res);
      return { status: res._s, headers: res._h || {}, body: Buffer.concat(chunks) };
    },
    async get(url, opts) { return this.request('GET', url, opts); },
    async getJSON(url, opts) { const r = await this.get(url, opts); return { status: r.status, headers: r.headers, body: JSON.parse(r.body.toString('utf8')) }; },
  };
}

const AUTH = (h = {}) => ({ headers: { 'X-OTA-Token': 'test-token', ...h } });

// ---------------------------------------------------------------- server endpoints

test('OTA endpoints fail closed when OTA_TOKEN is unset', async () => {
  const otaDir = tmpdir();
  publishFixture(otaDir);
  const h = serverHarness({ OTA_TOKEN: '', OTA_DIR: otaDir });
  for (const url of ['/api/firmware/manifest', '/firmware/1.3.1/firmware.bin']) {
    const r = await h.get(url, { headers: { 'X-OTA-Token': 'test-token' } });
    assert.equal(r.status, 401, url);
  }
});

test('OTA endpoints require a matching X-OTA-Token', async () => {
  const otaDir = tmpdir();
  publishFixture(otaDir);
  const h = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: otaDir });
  assert.equal((await h.get('/api/firmware/manifest')).status, 401);
  assert.equal((await h.get('/api/firmware/manifest', { headers: { 'X-OTA-Token': 'wrong' } })).status, 401);
  assert.equal((await h.get('/firmware/1.3.1/firmware.bin')).status, 401);
  assert.equal((await h.get('/api/firmware/manifest', AUTH())).status, 200);
});

test('OTA endpoints reject sources outside the allowed CIDRs', async () => {
  const otaDir = tmpdir();
  publishFixture(otaDir);
  const h = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: otaDir });
  for (const ip of ['192.168.9.50', '8.8.8.8']) {
    assert.equal((await h.get('/api/firmware/manifest', { ...AUTH(), ip })).status, 403, ip);
  }
  for (const ip of ['100.72.135.8', '100.100.0.1', '127.0.0.1', '::ffff:100.72.135.8']) {
    assert.equal((await h.get('/api/firmware/manifest', { ...AUTH(), ip })).status, 200, ip);
  }
});

test('manifest returns the exact enabled payload with actual size and sha256', async () => {
  const otaDir = tmpdir();
  const { bin, manifest } = publishFixture(otaDir);
  const h = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: otaDir });
  const r = await h.getJSON('/api/firmware/manifest', AUTH());
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['chip', 'enabled', 'layout', 'path', 'project', 'sha256', 'size', 'version']);
  assert.deepEqual(r.body, {
    enabled: true, version: manifest.version, project: manifest.project,
    chip: manifest.chip, layout: manifest.layout, size: bin.length,
    sha256: sha256(bin), path: manifest.path,
  });
  assert.equal(r.headers['Content-Length'], String(Buffer.byteLength(JSON.stringify(r.body))));
});

test('disabled updates return {"enabled":false} and the binary is not served', async () => {
  const otaDir = tmpdir();
  publishFixture(otaDir, { enabled: false });
  const h = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: otaDir });
  const m = await h.getJSON('/api/firmware/manifest', AUTH());
  assert.equal(m.status, 200);
  assert.deepEqual(m.body, { enabled: false });
  assert.equal((await h.get('/firmware/1.3.1/firmware.bin', AUTH())).status, 404);
  // no manifest file at all behaves the same
  const empty = tmpdir();
  const h2 = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: empty });
  assert.deepEqual((await h2.getJSON('/api/firmware/manifest', AUTH())).body, { enabled: false });
});

test('binary download is byte-for-byte identical with exact Content-Length', async () => {
  const otaDir = tmpdir();
  const { bin, manifest } = publishFixture(otaDir, { bin: makeBin(65537) });
  const h = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: otaDir });
  const r = await h.get(manifest.path, AUTH());
  assert.equal(r.status, 200);
  assert.ok(r.body.equals(bin));
  assert.equal(r.headers['Content-Length'], String(bin.length));
  assert.equal(r.headers['Transfer-Encoding'], undefined);
  assert.equal(r.headers['Content-Encoding'], undefined);
  assert.equal(r.headers['Content-Type'], 'application/octet-stream');
  assert.equal(r.headers['Location'], undefined);
});

test('the last reported firmware version is captured from the User-Agent', async () => {
  const otaDir = tmpdir();
  publishFixture(otaDir);
  const h = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: otaDir });
  await h.getJSON('/api/firmware/manifest', AUTH({ 'User-Agent': 'EnergyAnalyzer-OTA/1.3.0 (esp32s3)' }));
  const s = await h.getJSON('/api/status');
  assert.equal(s.body.ota.reported_version, '1.3.0');
  assert.ok(s.body.ota.reported_at > 0);
  assert.equal(s.body.ota.active_version, '1.3.1');
});

test('binary paths outside the active release are never served', async () => {
  const otaDir = tmpdir();
  publishFixture(otaDir);
  fs.writeFileSync(path.join(otaDir, 'secret.txt'), 'do not serve');
  const h = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: otaDir });
  for (const url of ['/firmware/9.9.9/firmware.bin',
    '/firmware/1.3.1/../secret.txt',
    '/firmware/manifest.json',
    '/firmware/']) {
    const r = await h.get(url, AUTH());
    assert.equal(r.status, 404, `${url} → ${r.status}`);
    assert.ok(!r.body.toString().includes('do not serve'), url);
  }
  // '..' escaping the /firmware/ prefix falls through to the public static
  // space (which never contains the OTA store) and can never return 200 here.
  const esc = await h.get('/firmware/1.3.1/../../secret.txt', AUTH());
  assert.notEqual(esc.status, 200);
  assert.ok(!esc.body.toString().includes('do not serve'));
});

test('ingest and dashboard stay available when OTA is configured', async () => {
  const otaDir = tmpdir();
  publishFixture(otaDir);
  const h = serverHarness({ OTA_TOKEN: 'test-token', OTA_DIR: otaDir });
  const ing = await h.request('POST', '/api/ingest', {
    headers: { 'Content-Type': 'application/json' },
  });
  assert.notEqual(ing.status, 404); // route still exists (400 for empty body)
  const status = await h.getJSON('/api/status');
  assert.equal(status.body.ota.token_configured, true);
});

// ---------------------------------------------------------------- publish CLI

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OTA_TOKEN: '', ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function writeInput(dir, { bin = makeBin(), meta = {} } = {}) {
  const binPath = path.join(dir, 'firmware.bin');
  fs.writeFileSync(binPath, bin);
  const manifest = {
    version: '1.3.1', project: 'EnergyAnalyzer', chip: 'esp32s3',
    layout: 'energymeter-ota-v1', size: bin.length, sha256: sha256(bin),
    ...meta,
  };
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { bin, binPath, manifest, manifestPath };
}

test('publish CLI accepts a valid ESP32-S3 image and writes the active manifest', () => {
  const dir = tmpdir();
  const otaDir = path.join(dir, 'ota');
  const { bin, binPath, manifest, manifestPath } = writeInput(dir);
  const r = runCli([binPath, manifestPath, '--ota-dir', otaDir]);
  assert.equal(r.status, 0, r.stderr);
  const storedBin = fs.readFileSync(path.join(otaDir, 'releases', '1.3.1', 'firmware.bin'));
  assert.ok(storedBin.equals(bin));
  const active = JSON.parse(fs.readFileSync(path.join(otaDir, 'manifest.json'), 'utf8'));
  assert.equal(active.enabled, true);
  assert.equal(active.version, manifest.version);
  assert.equal(active.size, bin.length);
  assert.equal(active.sha256, sha256(bin));
  assert.equal(active.path, '/firmware/1.3.1/firmware.bin');
  assert.ok(active.published_at);
  assert.deepEqual(fs.readdirSync(otaDir).filter(f => f.endsWith('.tmp')), []);
});

test('publish CLI rejects bad image headers and metadata', () => {
  const cases = [
    ['bad magic', { bin: makeBin(4096, 0x0009, 0x00) }],
    ['wrong chip id', { bin: makeBin(4096, 0x0000) }],
    ['sha mismatch', { meta: { sha256: '0'.repeat(64) } }],
    ['size mismatch', { meta: { size: 1 } }],
    ['oversize binary', { bin: makeBin(OTA_SIZE_CAP + 1) }],
    ['non-semver version', { meta: { version: '1.3' } }],
    ['wrong chip name', { meta: { chip: 'esp32' } }],
    ['missing layout', { meta: { layout: '' } }],
  ];
  for (const [name, opts] of cases) {
    const dir = tmpdir();
    const otaDir = path.join(dir, 'ota');
    const { binPath, manifestPath } = writeInput(dir, opts);
    const r = runCli([binPath, manifestPath, '--ota-dir', otaDir]);
    assert.notEqual(r.status, 0, `${name} must be rejected`);
    assert.ok(!fs.existsSync(path.join(otaDir, 'releases')), name);
    assert.ok(!fs.existsSync(path.join(otaDir, 'manifest.json')), name);
  }
});

test('publish CLI is idempotent for identical bytes and refuses different bytes', () => {
  const dir = tmpdir();
  const otaDir = path.join(dir, 'ota');
  const { binPath, manifestPath } = writeInput(dir);
  assert.equal(runCli([binPath, manifestPath, '--ota-dir', otaDir]).status, 0);
  assert.equal(runCli([binPath, manifestPath, '--ota-dir', otaDir]).status, 0);
  const bin = fs.readFileSync(path.join(otaDir, 'releases', '1.3.1', 'firmware.bin'));
  assert.ok(bin.equals(fs.readFileSync(binPath)));
  // same version, different bytes → immutable release, publish refused
  const dir2 = tmpdir();
  const { binPath: binPath2, manifestPath: manifestPath2 } = writeInput(dir2, { bin: makeBin(8192) });
  const r = runCli([binPath2, manifestPath2, '--ota-dir', otaDir]);
  assert.notEqual(r.status, 0);
  const still = fs.readFileSync(path.join(otaDir, 'releases', '1.3.1', 'firmware.bin'));
  assert.ok(still.equals(bin), 'immutable release must not be overwritten');
});

test('publish CLI retains old releases and switches the active manifest', () => {
  const dir = tmpdir();
  const otaDir = path.join(dir, 'ota');
  const a = writeInput(dir, { meta: { version: '1.3.1' } });
  assert.equal(runCli([a.binPath, a.manifestPath, '--ota-dir', otaDir]).status, 0);
  const b = writeInput(dir, { bin: makeBin(6000), meta: { version: '1.3.2' } });
  assert.equal(runCli([b.binPath, b.manifestPath, '--ota-dir', otaDir]).status, 0);
  assert.ok(fs.existsSync(path.join(otaDir, 'releases', '1.3.1', 'firmware.bin')));
  assert.ok(fs.existsSync(path.join(otaDir, 'releases', '1.3.2', 'firmware.bin')));
  const active = JSON.parse(fs.readFileSync(path.join(otaDir, 'manifest.json'), 'utf8'));
  assert.equal(active.version, '1.3.2');
  assert.equal(active.path, '/firmware/1.3.2/firmware.bin');
});

test('publish CLI --disable publishes an inactive manifest', () => {
  const dir = tmpdir();
  const otaDir = path.join(dir, 'ota');
  const { binPath, manifestPath } = writeInput(dir);
  const r = runCli([binPath, manifestPath, '--disable', '--ota-dir', otaDir]);
  assert.equal(r.status, 0, r.stderr);
  const active = JSON.parse(fs.readFileSync(path.join(otaDir, 'manifest.json'), 'utf8'));
  assert.equal(active.enabled, false);
});
