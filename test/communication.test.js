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

test('a missed pull preserves recent contact and does not override a healthy push feed', async () => {
  const h = serverHarness();
  h.run(`fetch = async () => ({ok: true, json: async () => ({meter: ${JSON.stringify(meter())}})})`);
  await h.run('pollEsp32()');
  const before = (await h.get('/api/readings')).body;
  h.advance(2000);
  h.run('fetch = async () => { throw new Error("connection refused"); }');
  await h.run('pollEsp32()');
  const missed = (await h.get('/api/readings')).body;
  assert.equal(missed.meta.device.health.code, 'ok');
  assert.equal(missed.meta.device.connected, true);
  assert.equal(missed.meta.device.stale, false);
  assert.equal(missed.meta.device.last_seen, before.meta.device.last_seen);
  assert.equal(missed.meta.device.last_error, 'connection refused');
  assert.deepEqual(missed.sample, before.sample);
  h.advance(2000);
  h.run(`fetch = async () => ({ok: true, json: async () => ({meter: ${JSON.stringify(meter({ sequence: 2 }))}})})`);
  await h.run('pollEsp32()');
  const recovered = (await h.get('/api/readings')).body;
  assert.equal(recovered.meta.device.health.code, 'ok');
  assert.equal(recovered.meta.device.last_error, null);
  assert.equal(recovered.sample.seq, 2);
  assert.ok(recovered.sample.tot.e_wh > before.sample.tot.e_wh);
  h.ingest(meter({ sequence: 3 }));
  h.run('fetch = async () => { throw new Error("connection refused"); }');
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

test('power registers arrive in kW and are scaled to W; per-phase frequency is preserved', async () => {
  const h = serverHarness();
  h.ingest(meter({ groups: [
    { key: 'active_power', values: [0.5, 1, 1.5] },
    { key: 'reactive_power', values: [0.1, 0.2, 0.3] },
    { key: 'apparent_power', values: [0.5, 1, 1.5] },
    { key: 'active_power_demand', values: [4.403, 4.402, 4.402] },
    { key: 'apparent_power_demand', values: [4.403, 4.402, 4.402] },
    { key: 'voltage_ln', values: [230, 230, 230] },
    { key: 'frequency', values: [50, 50.1, 49.9] },
  ] }));
  const { body } = await h.get('/api/readings');
  assert.equal(body.sample.l1.p, 500);
  assert.equal(body.sample.l2.p, 1000);
  assert.equal(body.sample.l3.p, 1500);
  assert.equal(body.sample.tot.p, 3000);
  assert.equal(body.sample.l1.p_d, 4403);
  assert.equal(body.sample.l1.q, 100);
  assert.equal(body.sample.l1.s, 500);
  assert.equal(body.sample.l2.freq, 50.1);
  assert.equal(body.sample.l3.freq, 49.9);
  assert.equal(body.sample.freq, 50);
});

test('total power factor keeps its sign so reverse power flow is visible', async () => {
  const h = serverHarness();
  h.ingest(meter({ groups: [
    { key: 'active_power', values: [0.1, -0.9, -0.8] },
    { key: 'apparent_power', values: [0.1, 0.9, 0.8] },
  ] }));
  const { body } = await h.get('/api/readings');
  assert.ok(body.sample.tot.pf < 0);
});

test('negative (exporting) power does not reduce accumulated import energy', async () => {
  const h = serverHarness();
  h.ingest(meter({ groups: [{ key: 'active_power', values: [-1, -1, -1] }] }));
  h.advance(2000);
  h.ingest(meter({ groups: [{ key: 'active_power', values: [-1, -1, -1] }], sequence: 2 }));
  const { body } = await h.get('/api/readings');
  assert.equal(body.sample.tot.e_wh, 0);
  assert.equal(body.sample.l1.e_wh, 0);
});

test('ESP32 contact expires only after 8 seconds for push, pull and legacy ingestion', async () => {
  for (const feed of ['push', 'pull', 'legacy']) {
    const h = serverHarness();
    const report = async sequence => {
      if (feed === 'push') h.ingest(meter({ sequence }));
      else if (feed === 'pull') {
        h.run(`fetch = async () => ({ok: true, json: async () => ({meter: ${JSON.stringify(meter({ sequence }))}})})`);
        await h.run('pollEsp32()');
      } else {
        await h.run('handleIngest({headers: {}}, {writeHead() {}, end() {}}, {phases: {l1: {p: 100}, l2: {p: 200}, l3: {p: 300}}})');
      }
    };
    await report(1);
    const before = (await h.get('/api/readings')).body;
    h.run('fetch = async () => { throw new Error("request timed out"); }');
    h.advance(7999);
    if (feed === 'pull') await h.run('pollEsp32()');
    assert.equal((await h.get('/api/status')).body.device.health.code, 'ok', feed);
    h.advance(1);
    if (feed === 'pull') await h.run('pollEsp32()');
    assert.equal((await h.get('/api/status')).body.device.connected, true, feed);
    h.advance(1);
    if (feed === 'pull') await h.run('pollEsp32()');
    const lost = (await h.get('/api/readings')).body;
    assert.equal(lost.meta.device.timeout_ms, 8000, feed);
    assert.equal(lost.meta.device.connected, false, feed);
    assert.equal(lost.meta.device.health.code, 'esp32_offline', feed);
    assert.equal(lost.meta.device.last_seen, before.meta.device.last_seen, feed);
    assert.deepEqual(lost.sample, before.sample, feed);
    assert.equal(lost.meta.buffers.sec, before.meta.buffers.sec, feed);
    await report(2);
    const recovered = (await h.get('/api/readings')).body;
    assert.equal(recovered.meta.device.health.code, 'ok', feed);
    assert.equal(recovered.meta.device.last_error, null, feed);
    assert.equal(recovered.sample.tot.e_wh, before.sample.tot.e_wh, feed);
    h.advance(6000);
    await report(3);
    h.advance(6000);
    assert.equal((await h.get('/api/status')).body.device.health.code, 'ok', feed);
    h.advance(2001);
    assert.equal((await h.get('/api/status')).body.device.health.code, 'esp32_offline', feed);
  }
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
