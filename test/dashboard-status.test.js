'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function clientHarness(data, error = null) {
  const elements = new Map();
  const element = () => ({
    textContent: '', className: '', hidden: false, dataset: {},
    style: { setProperty() {} }, setAttribute() {}, append() {},
  });
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: get, createElement: element,
      querySelectorAll: () => [], documentElement: element() },
    localStorage: { getItem() { return null; } },
    getComputedStyle: () => ({ getPropertyValue: () => '#333333' }),
    clearTimeout() {}, AbortSignal,
    fetch: async () => { if (error) throw error; return { ok: true, json: async () => data }; },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  vm.runInContext(source.replace('  boot();',
    '  globalThis.client = { updateSourcePills, pollReadings, S };'), context);
  context.client.S.online = true;
  return { ...context.client, get };
}

function readings(code, severity, message) {
  return { source: 'device', sample: null, meta: {
    source_mode: 'auto', started_at: Date.now(), buffers: { sec: 0, min: 0 },
    device: { connected: code !== 'esp32_offline', stale: code !== 'ok',
      health: { code, severity, message } },
  } };
}

test('dashboard displays specific fault feedback and a non-live badge', () => {
  for (const [code, severity, message, label] of [
    ['adapter_disconnected', 'error', 'ESP32 reports RS-485 adapter disconnected.', 'RS-485 disconnected'],
    ['meter_error', 'error', 'Meter communication failed: timeout.', 'Meter error'],
    ['meter_no_data', 'warning', 'No meter sample is available.', 'No meter data'],
    ['meter_stale', 'warning', 'Meter readings are not updating.', 'Meter stale'],
    ['esp32_offline', 'error', 'Communication lost with ESP32.', 'ESP32 offline'],
  ]) {
    const data = readings(code, severity, message);
    const h = clientHarness(data);
    h.updateSourcePills(data);
    assert.equal(h.get('sourcePill').textContent, label);
    assert.ok(h.get('noticeText').textContent.includes(message));
    assert.equal(h.get('notice').hidden, false);
    assert.ok(!h.get('sideDot').className.includes('pulse'));
  }
});

test('reachable server with no meter sample is not reported as server offline', async () => {
  const h = clientHarness(readings('meter_no_data', 'warning', 'No meter sample is available.'));
  await h.pollReadings();
  assert.equal(h.S.online, true);
  assert.equal(h.get('sourcePill').textContent, 'No meter data');
  assert.ok(h.get('noticeText').textContent.includes('No meter sample'));
});

test('server connection failures replace any previously green status', async () => {
  const h = clientHarness(null, new Error('network unavailable'));
  h.get('sourcePill').textContent = 'Device';
  h.get('sideDot').className = 'dot ok pulse';
  await h.pollReadings();
  assert.equal(h.S.online, false);
  assert.equal(h.get('sourcePill').textContent, 'Server offline');
  assert.equal(h.get('sideDot').className, 'dot bad');
});
