'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real server with a controllable clock and no listening socket or
// hardware traffic. Tests exercise its ingestion and HTTP handlers directly.
function serverHarness() {
  let now = 100000;
  let handler;
  const intervals = [];
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    require(name) {
      if (name === 'http') return { createServer(fn) {
        handler = fn;
        return { listen() {} };
      } };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '..'),
    process: { env: { ESP32_URL: '', DB_PATH: ':memory:' } },
    console: { log() {} }, Date: Clock, URL, AbortSignal, Buffer,
    fetch: () => new Promise(() => {}),
    setInterval(fn) { intervals.push(fn); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), context);
  return {
    run(code) { return vm.runInContext(code, context); },
    ingest(meter) {
      context.payload = meter;
      vm.runInContext('ingestMeterPayload(payload, Date.now(), "push")', context);
    },
    advance(ms) { now += ms; intervals.forEach(fn => fn()); },
    async get(url) {
      let status, body;
      await handler({ method: 'GET', url, headers: {} }, {
        writeHead(code) { status = code; },
        end(data) { body = JSON.parse(data); },
      });
      return { status, body };
    },
  };
}

function meter(overrides = {}) {
  return {
    has_sample: true, adapter_connected: true, stale: false,
    last_error: null, sequence: 1, age_ms: 100,
    groups: [
      { key: 'active_power', values: [100, 200, 300] },
      { key: 'apparent_power', values: [100, 200, 300] },
      { key: 'voltage_ln', values: [230, 230, 230] },
    ],
    ...overrides,
  };
}

test('disconnected RS-485 adapter is distinct from an offline ESP32 and freezes samples', async () => {
  const h = serverHarness();
  h.ingest(meter());
  const before = (await h.get('/api/readings')).body;
  h.advance(2000);
  h.ingest(meter({ adapter_connected: false, sequence: 2 }));
  const { body } = await h.get('/api/readings');
  assert.equal(body.meta.device.health.code, 'adapter_disconnected');
  assert.equal(body.meta.device.connected, true);
  assert.equal(body.meta.device.stale, true);
  assert.deepEqual(body.sample, before.sample);
  assert.equal(body.meta.buffers.sec, before.meta.buffers.sec);
});

test('meter faults are reported without losing ESP32 contact or accepting bad samples', async () => {
  for (const [fault, code] of [
    [{ last_error: 'Modbus response timeout', sequence: 2 }, 'meter_error'],
    [{ has_sample: false }, 'meter_no_data'],
    [{ stale: true, sequence: 2 }, 'meter_stale'],
    [{ age_ms: 15001, sequence: 2 }, 'meter_stale'],
  ]) {
    const h = serverHarness();
    h.ingest(meter());
    const before = (await h.get('/api/readings')).body;
    h.advance(2000);
    h.ingest(meter(fault));
    const { body } = await h.get('/api/readings');
    assert.equal(body.meta.device.health.code, code);
    assert.equal(body.meta.device.connected, true);
    assert.equal(body.meta.device.stale, true);
    assert.deepEqual(body.sample, before.sample);
    if (fault.last_error) assert.equal(body.meta.device.meter_error, fault.last_error);
  }
});

test('repeated sequence becomes stale despite heartbeats, and recovery skips outage energy', async () => {
  const h = serverHarness();
  h.ingest(meter());
  h.advance(2000);
  h.ingest(meter({ sequence: 2 }));
  const before = (await h.get('/api/readings')).body;
  for (let i = 0; i < 8; i++) {
    h.advance(2000);
    h.ingest(meter({ sequence: 2, age_ms: 0 }));
  }
  const fault = (await h.get('/api/readings')).body;
  assert.equal(fault.meta.device.health.code, 'meter_stale');
  assert.equal(fault.meta.device.connected, true);
  assert.deepEqual(fault.sample, before.sample);
  assert.equal(fault.meta.buffers.sec, before.meta.buffers.sec);
  h.ingest(meter({ sequence: 3 }));
  const recovered = (await h.get('/api/readings')).body;
  assert.equal(recovered.meta.device.health.code, 'ok');
  assert.equal(recovered.sample.seq, 3);
  assert.equal(recovered.sample.tot.e_wh, before.sample.tot.e_wh);
});

test('a fault before the first sample returns status metadata, not a misleading server error or simulation', async () => {
  const h = serverHarness();
  h.ingest(meter({ has_sample: false, adapter_connected: false }));
  const { status, body } = await h.get('/api/readings');
  assert.equal(status, 200);
  assert.equal(body.source, 'device');
  assert.equal(body.sample, null);
  assert.equal(body.meta.device.health.code, 'adapter_disconnected');
  assert.equal(body.meta.sim.running, false);
  h.ingest(meter({ sequence: 2 }));
  assert.equal((await h.get('/api/readings')).body.sample.seq, 2);
});

test('legacy push recovery clears old native meter faults and starts a fresh heartbeat', async () => {
  const h = serverHarness();
  h.ingest(meter({ adapter_connected: false, last_error: 'adapter missing' }));
  await h.run('handleIngest({headers: {}}, {writeHead() {}, end() {}}, {phases: {l1: {p: 100}, l2: {p: 200}, l3: {p: 300}}})');
  const { body } = await h.get('/api/status');
  assert.equal(body.device.health.code, 'ok');
  assert.equal(body.device.adapter_connected, null);
  assert.equal(body.device.meter_error, null);
  h.advance(15001);
  assert.equal((await h.get('/api/status')).body.device.health.code, 'esp32_offline');
});

test('pull failures are distinct from meter faults and do not override a healthy push feed', async () => {
  const h = serverHarness();
  h.run(`fetch = async () => ({ok: true, json: async () => ({meter: ${JSON.stringify(meter())}})})`);
  await h.run('pollEsp32()');
  assert.equal((await h.get('/api/status')).body.device.health.code, 'ok');
  h.run('fetch = async () => { throw new Error("connection refused"); }');
  await h.run('pollEsp32()');
  assert.equal((await h.get('/api/status')).body.device.health.code, 'esp32_offline');
  h.ingest(meter({ sequence: 2 }));
  await h.run('pollEsp32()');
  const { body } = await h.get('/api/status');
  assert.equal(body.device.health.code, 'ok');
  assert.equal(body.device.feed, 'push');
});

test('zero measurements and an unknown adapter flag are not disconnection evidence', async () => {
  const h = serverHarness();
  h.ingest(meter({ adapter_connected: undefined, groups: [{ key: 'active_power', values: [0, 0, 0] }] }));
  const { body } = await h.get('/api/readings');
  assert.equal(body.meta.device.health.code, 'ok');
  assert.equal(body.meta.device.adapter_connected, null);
  assert.equal(body.sample.tot.p, 0);
});

test('loss of ESP32 contact is offline, not just a generic stale meter', async () => {
  const h = serverHarness();
  h.ingest(meter());
  const before = (await h.get('/api/readings')).body;
  h.advance(15001);
  const { body } = await h.get('/api/status');
  assert.equal(body.device.connected, false);
  assert.equal(body.device.health.code, 'esp32_offline');
  assert.equal(body.device.stale, true);
  assert.equal(body.source, 'device');
  const after = (await h.get('/api/readings')).body;
  assert.deepEqual(after.sample, before.sample);
  assert.equal(after.meta.device.health.code, 'esp32_offline');
  assert.equal(after.meta.buffers.sec, before.meta.buffers.sec);
});
