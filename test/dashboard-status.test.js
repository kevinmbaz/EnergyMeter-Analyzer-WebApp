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
    getComputedStyle: () => ({ getPropertyValue: name =>
      ({ '--p1': '#111111', '--p2': '#222222', '--p3': '#333333',
         '--accent': '#999999', '--muted': '#777777', '--faint': '#666666',
         '--line': '#555555', '--ink': '#444444', '--panel': '#333333' }[name] || '#333333') }),
    clearTimeout() {}, AbortSignal,
    fetch: async () => { if (error) throw error; return { ok: true, json: async () => data }; },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  vm.runInContext(source.replace('  boot();',
    '  globalThis.client = { updateSourcePills, pollReadings, S, chartPalette, seriesDs };'), context);
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

test('provisional register metadata never shows a banner or adds text to a communication fault', () => {
  for (const [code, severity, message] of [
    ['ok', 'ok', 'ESP32 connected; meter readings are live.'],
    ['esp32_offline', 'error', 'Communication lost with ESP32.'],
    ['meter_stale', 'warning', 'RS-485 is not receiving meter data.'],
  ]) {
    const data = readings(code, severity, message);
    data.meta.device.candidate_layout = true;
    const h = clientHarness(data);
    h.updateSourcePills(data);
    assert.equal(h.get('notice').hidden, code === 'ok');
    assert.ok(!h.get('noticeText').textContent.includes('Provisional register map'));
    if (code !== 'ok') assert.equal(h.get('noticeText').textContent, message + ' No valid meter sample yet.');
  }
});

test('phase chart series use their own colors, not a shared accent fallback', () => {
  const h = clientHarness(readings('ok', 'ok', 'ESP32 connected; meter readings are live.'));
  const palette = h.chartPalette();
  const ds1 = h.seriesDs('l1', '--p1', 'L1', null);
  const ds2 = h.seriesDs('l2', '--p2', 'L2', null);
  const ds3 = h.seriesDs('l3', '--p3', 'L3', null);
  assert.equal(ds1.borderColor, palette['--p1']);
  assert.equal(ds2.borderColor, palette['--p2']);
  assert.equal(ds3.borderColor, palette['--p3']);
  assert.ok(ds1.borderColor !== ds2.borderColor
    && ds2.borderColor !== ds3.borderColor && ds1.borderColor !== ds3.borderColor,
    'L1/L2/L3 series must render in three distinct colors');
});

test('ESP32 firmware stays visible before the device reports its version', () => {
  const data = readings('ok', 'ok', 'ESP32 connected; meter readings are live.');
  const h = clientHarness(data);
  for (const version of [null, '2.1.0', null]) {
    data.meta.ota = { reported_version: version, reported_at: version ? Date.now() : null };
    h.updateSourcePills(data);
    assert.equal(h.get('sideFirmware').hidden, false);
    assert.equal(h.get('sideFirmware').textContent,
      version ? `ESP32 firmware: v${version}` : 'ESP32 firmware: Not reported');
  }
});

test('reverse power flow is called out, not shown as zero', () => {
  const data = readings('ok', 'ok', 'ESP32 connected; meter readings are live.');
  data.sample = { t: Date.now(), seq: 1, freq: 50,
    tot: { p: 100, pf: -0.9, e_wh: 0 },
    l1: { pf: 0.99, p: 100 }, l2: { pf: -0.99, p: -50 }, l3: { pf: -0.94, p: -30 } };
  const h = clientHarness(data);
  h.updateSourcePills(data);
  assert.ok(h.get('noticeText').textContent.includes('reverse power flow'));
  assert.ok(h.get('noticeText').textContent.includes('L2/L3'));
  assert.equal(h.get('notice').hidden, false);
});

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
