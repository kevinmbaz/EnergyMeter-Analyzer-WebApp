'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Real routes + SQLite, isolated from hardware, listeners and production data.
function serverHarness(t, env = {}, startAt = 100000) {
  let now = startAt, handler;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    require(name) {
      if (name === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '..'),
    process: { env: { ESP32_URL: '', DB_PATH: ':memory:', OTA_DIR: tmpdir(t),
      INGEST_TOKEN: 'test-ingest', OTA_TOKEN: 'test-ota', ...env } },
    console: { log() {}, error() {} }, Date: Clock, URL, AbortSignal, Buffer,
    fetch: () => new Promise(() => {}), setInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), context);
  let closed = false;
  const h = {
    run(code) { return vm.runInContext(code, context); },
    close() { if (!closed) { h.run('if (db) db.close()'); closed = true; } },
    advance(ms) { now += ms; },
    async request(method, url, body, headers = {}, ip = '100.72.135.8') {
      const buf = body === undefined ? Buffer.alloc(0)
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      let status, raw;
      const req = {
        method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        socket: { remoteAddress: ip },
        on(event, cb) {
          if (event === 'data' && buf.length) cb(buf);
          if (event === 'end') cb();
          return this;
        }, destroy() {},
      };
      await handler(req, { writeHead(code) { status = code; }, end(data) { raw = data; } });
      return { status, body: JSON.parse(raw) };
    },
    async status() { return (await h.request('GET', '/api/status')).body; },
    async ingest(body, headers = {}) {
      return h.request('POST', '/api/ingest', body, { 'X-Ingest-Token': 'test-ingest', ...headers });
    },
    async poll(body, ok = true) {
      context.polled = body;
      h.run(`fetch = async () => ({ ok: ${ok}, status: ${ok ? 200 : 500}, json: async () => polled })`);
      await h.run('pollEsp32()');
    },
  };
  t.after(h.close);
  return h;
}

function statusUpload(version) {
  return { firmware_version: version, meter: {
    adapter_connected: false, has_sample: false, stale: true, last_error: 'RS-485 disconnected',
  } };
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-fw-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('authenticated JSON firmware metadata survives status-only meter faults', async t => {
  const h = serverHarness(t);
  assert.equal((await h.ingest(statusUpload('1.3.3'))).status, 200);
  const s = await h.status();
  assert.equal(s.device.firmware.version, '1.3.3');
  assert.equal(s.device.firmware.source, 'ingest.json');
  assert.equal(s.device.firmware.reported_at, 100000);
  assert.equal(s.device.health.code, 'adapter_disconnected');
  assert.equal(s.ota.reported_version, '1.3.3');
  assert.equal(s.ota.active_version, null);
  const r = await h.request('GET', '/api/readings');
  assert.deepEqual(r.body.meta.device.firmware, s.device.firmware);
  assert.equal(r.body.sample, null);
});

test('ingest uses X-Firmware-Version only when the JSON field is absent', async t => {
  const h = serverHarness(t);
  await h.ingest(statusUpload(undefined), { 'X-Firmware-Version': '1.3.2' });
  let s = await h.status();
  assert.equal(s.device.firmware.version, '1.3.2');
  assert.equal(s.device.firmware.source, 'ingest.header');
  await h.ingest(statusUpload('1.3.3'), { 'X-Firmware-Version': '9.9.9' });
  s = await h.status();
  assert.equal(s.device.firmware.version, '1.3.3');
  assert.equal(s.device.firmware.source, 'ingest.json');
});

test('last valid report persists across restarts and is scoped to the configured ESP32', async t => {
  const DB_PATH = path.join(tmpdir(t), 'meter.db');
  const env = { DB_PATH, ESP32_DEVICE_ID: 'esp32-a' };
  const h = serverHarness(t, env);
  await h.ingest(statusUpload('1.3.3'));
  h.advance(2000);
  await h.ingest(statusUpload('1.3.2')); // rollback, not the highest ever seen
  h.advance(2000);
  await h.ingest(statusUpload('1.3.2')); // same version refreshes observation time
  await h.ingest(statusUpload(undefined)); // legacy messages must not erase it
  const last = (await h.status()).device.firmware;
  assert.equal(last.version, '1.3.2');
  assert.equal(last.reported_at, 104000);
  h.close();
  const other = serverHarness(t, { ...env, ESP32_DEVICE_ID: 'esp32-b' }, 120000);
  assert.equal((await other.status()).device.firmware.version, null);
  await other.ingest(statusUpload('2.0.0'));
  other.close();
  const restarted = serverHarness(t, env, 140000);
  const report = (await restarted.status()).device.firmware;
  assert.equal(report.device_id, 'esp32-a');
  assert.equal(report.version, last.version);
  assert.equal(report.reported_at, last.reported_at);
  assert.equal(report.source, last.source);
  assert.equal(report.stale, true);
  await restarted.ingest(statusUpload(undefined));
  assert.equal((await restarted.status()).device.firmware.version, '1.3.2');
});

test('successful configured LAN polling records JSON metadata without curing a meter fault', async t => {
  const h = serverHarness(t);
  await h.poll(statusUpload('1.3.3'));
  const s = await h.status();
  assert.equal(s.device.firmware.version, '1.3.3');
  assert.equal(s.device.firmware.source, 'lan.json');
  assert.equal(s.device.health.code, 'adapter_disconnected');
  h.advance(2000);
  await h.poll(statusUpload('1.3.4'), false);
  assert.equal((await h.status()).device.firmware.version, '1.3.3');
  await h.poll(statusUpload(undefined));
  assert.equal((await h.status()).device.firmware.reported_at, 100000);
});

test('legacy OTA reporting accepts only an exact bounded User-Agent after token and CIDR checks', async t => {
  const h = serverHarness(t, { OTA_DIR: tmpdir(t) });
  const headers = { 'X-OTA-Token': 'test-ota', 'User-Agent': 'EnergyAnalyzer-OTA/1.3.2' };
  await h.ingest(statusUpload(undefined));
  const before = await h.status();
  for (const ua of ['prefix EnergyAnalyzer-OTA/1.3.3', 'EnergyAnalyzer/1.3.3',
    'EnergyAnalyzer-OTA/1.3.3 (esp32s3)', 'EnergyAnalyzer-OTA/1.3.3\n',
    'EnergyAnalyzer-OTA/1.3.65536', 'EnergyAnalyzer-OTA/1.3.3.4']) {
    await h.request('GET', '/api/firmware/manifest', undefined, { ...headers, 'User-Agent': ua });
    assert.equal((await h.status()).device.firmware.version, null, ua);
  }
  await h.request('GET', '/api/firmware/manifest', undefined, headers);
  let s = await h.status();
  assert.equal(s.device.firmware.version, '1.3.2');
  assert.equal(s.device.firmware.source, 'ota.user-agent');
  assert.deepEqual(s.device.health, before.device.health);
  assert.equal(s.device.last_sample_at, before.device.last_sample_at);
  assert.deepEqual(s.buffers, before.buffers);
  for (const [token, ip, status] of [['wrong', '100.72.135.8', 401],
    [undefined, '100.72.135.8', 401], ['test-ota', '8.8.8.8', 403]]) {
    const r = await h.request('GET', '/api/firmware/manifest', undefined,
      { 'X-OTA-Token': token, 'User-Agent': 'EnergyAnalyzer-OTA/9.9.9' }, ip);
    assert.equal(r.status, status);
    assert.equal((await h.status()).device.firmware.version, '1.3.2');
  }
  h.advance(60001);
  await h.request('GET', '/api/firmware/manifest', undefined, headers);
  s = await h.status();
  assert.equal(s.device.firmware.reported_at, 160001);
  assert.equal(s.device.health.code, 'esp32_offline');
  assert.equal(s.device.firmware.version, '1.3.2');
});

test('legacy serial headers are accepted after authentication without changing meter state', async t => {
  const h = serverHarness(t);
  await h.ingest(statusUpload(undefined));
  const before = await h.status();
  for (const auth of [{ 'X-OTA-Token': 'test-ota' }, { 'X-Ingest-Token': 'test-ingest' }]) {
    h.advance(2000);
    const r = await h.request('POST', '/api/serial', { lines: ['firmware log'] },
      { ...auth, 'X-Firmware-Version': '1.3.2' });
    assert.equal(r.status, 200);
    const s = await h.status();
    assert.equal(s.device.firmware.version, '1.3.2');
    assert.equal(s.device.firmware.source, 'serial.header');
    assert.equal(s.device.last_seen, before.device.last_seen);
    assert.equal(s.device.last_sample_at, before.device.last_sample_at);
    assert.deepEqual(s.device.health, before.device.health);
    assert.deepEqual(s.buffers, before.buffers);
  }
  for (const headers of [{}, { 'X-OTA-Token': 'wrong' }, { 'X-Ingest-Token': 'wrong' }]) {
    const r = await h.request('POST', '/api/serial', {}, { ...headers, 'X-Firmware-Version': '9.9.9' });
    assert.equal(r.status, 401);
    assert.equal((await h.status()).device.firmware.version, '1.3.2');
  }
});
