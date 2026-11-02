'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const elements = new Map(), requests = [], responses = [], timers = [];
  const get = id => {
    if (!elements.has(id)) {
      const listeners = {};
      const el = { textContent: '', hidden: false, disabled: false, checked: true, value: '',
        className: '', scrollTop: 0, scrollHeight: 1000, listeners,
        setAttribute() {}, addEventListener(name, fn) { listeners[name] = fn; } };
      Object.defineProperty(el, 'innerHTML', { set() { throw new Error('Console output must never use innerHTML'); } });
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: get, hidden: false },
    localStorage: { getItem() { return null; } }, URLSearchParams, AbortSignal,
    setTimeout(fn, ms) { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error('Unexpected console fetch');
      return await response;
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  vm.runInContext(source.replace('  boot();',
    '  globalThis.consoleUI = { S, pollSerialLogs, renderSerialLogs, resetSerialLogs, bindSerialControls };'), context);
  const ui = context.consoleUI;
  ui.S.view = 'settings';
  return { ...ui, get, requests, timers,
    respond(data, status = 200) { responses.push({ ok: status === 200, status, json: async () => data }); },
    fail(error) { responses.push(error); },
    deferred(promise) { responses.push(promise); },
  };
}

function batch(id, text, overrides = {}) {
  return { id, text, device_name: 'energymeter', firmware_version: '1.3.3', boot_id: 'boot-1',
    sequence: String(id), dropped_bytes: '0', received_at: Date.now(), ...overrides };
}
function page(batches, after, more = false) {
  return { batches, next_after: after, has_more: more };
}

test('Settings console renders raw text safely and follows the server cursor without inserting line breaks', async () => {
  const h = harness();
  const html = '<img src=x onerror=alert(1)><script>unsafe()</script>';
  h.respond(page([batch(1, 'hello\r\n' + html), batch(2, 'partial ')], 2));
  await h.pollSerialLogs();
  assert.equal(h.get('serialOutput').textContent, 'hello\r\n' + html + 'partial ');
  assert.equal(h.get('serialEmpty').hidden, true);
  assert.equal(h.get('serialOutput').scrollTop, 1000);
  assert.ok(h.get('serialMeta').textContent.includes('1.3.3'));
  assert.ok(h.get('serialMeta').textContent.includes('boot-1'));
  h.respond(page([batch(3, 'line\n')], 3));
  await h.pollSerialLogs();
  assert.equal(h.get('serialOutput').textContent, 'hello\r\n' + html + 'partial line\n');
  assert.match(h.requests[1].url, /after=2/);
  assert.equal(h.S.serial.after, 3);
  assert.equal(h.requests[0].options.headers['X-OTA-Token'], undefined);
});

test('log pause, manual refresh and resume are independent of chart pause', async () => {
  const h = harness();
  h.bindSerialControls();
  h.S.paused = true;
  h.respond(page([batch(1, 'first')], 1));
  await h.pollSerialLogs();
  await h.get('serialPause').listeners.click();
  assert.equal(h.get('serialPause').textContent, 'Resume logs');
  await h.pollSerialLogs();
  assert.equal(h.requests.length, 1);
  h.respond(page([batch(2, ' manual')], 2));
  await h.get('serialRefresh').listeners.click();
  assert.equal(h.S.serial.paused, true);
  assert.equal(h.get('serialOutput').textContent, 'first manual');
  h.respond(page([batch(3, ' resumed')], 3));
  await h.get('serialPause').listeners.click();
  assert.equal(h.get('serialOutput').textContent, 'first manual resumed');
  assert.equal(h.S.paused, true);
});

test('clear display keeps the cursor and never deletes stored logs', async () => {
  const h = harness();
  h.bindSerialControls();
  h.respond(page([batch(1, 'saved')], 1));
  await h.pollSerialLogs();
  h.get('serialClear').listeners.click();
  assert.equal(h.get('serialOutput').textContent, '');
  assert.equal(h.S.serial.after, 1);
  assert.equal(h.get('serialEmpty').hidden, false);
  h.respond(page([batch(2, 'new')], 2));
  await h.pollSerialLogs();
  assert.equal(h.get('serialOutput').textContent, 'new');
  assert.ok(h.requests.every(r => r.options.method === undefined));
});

test('device changes discard a late response from the previous device', async () => {
  const h = harness();
  let resolve;
  h.deferred(new Promise(r => { resolve = r; }));
  const oldRequest = h.pollSerialLogs();
  h.respond(page([batch(2, 'other', { device_name: 'other-esp32' })], 2));
  await h.resetSerialLogs('other-esp32');
  resolve({ ok: true, json: async () => page([batch(1, 'wrong device')], 1) });
  await oldRequest;
  assert.equal(h.get('serialOutput').textContent, 'other');
  assert.equal(h.S.serial.device, 'other-esp32');
  assert.match(h.requests[1].url, /device=other-esp32/);
});

test('paginated catch-up is bounded to 200 display batches while retaining the full server cursor', async () => {
  const h = harness();
  for (let start = 1; start <= 201; start += 100) {
    const batches = Array.from({ length: 100 }, (_, i) => batch(start + i, `${start + i},`));
    h.respond(page(batches, start + 99, start < 201));
    await h.pollSerialLogs();
  }
  assert.equal(h.S.serial.entries.length, 200);
  assert.equal(h.S.serial.entries[0].id, 101);
  assert.equal(h.S.serial.after, 300);
  assert.equal(h.S.serial.truncated, true);
  assert.ok(h.get('serialSummary').textContent.includes('latest 200'));
  assert.ok(h.timers.some(timer => timer.ms === 100));
});

test('empty and unavailable log states are honest and errors retain last displayed text', async () => {
  const h = harness();
  h.respond(page([], 0));
  await h.pollSerialLogs();
  assert.equal(h.get('serialEmpty').hidden, false);
  assert.equal(h.get('serialPill').textContent, 'Waiting for logs');
  h.respond(page([batch(1, 'retained')], 1));
  await h.pollSerialLogs();
  h.respond({}, 403);
  await h.pollSerialLogs();
  assert.ok(h.get('serialMessage').textContent.includes('Tailscale'));
  assert.equal(h.get('serialMessage').hidden, false);
  assert.equal(h.get('serialOutput').textContent, 'retained');
  h.fail(new Error('network unavailable'));
  await h.pollSerialLogs();
  assert.equal(h.get('serialPill').textContent, 'Logs unavailable');
  assert.equal(h.S.serial.after, 1);
  h.respond(page([], 1));
  await h.pollSerialLogs();
  assert.equal(h.get('serialMessage').hidden, true);
});

test('malformed pages never skip a cursor or start an endless catch-up loop', async () => {
  const h = harness();
  for (const data of [page([], 0, true), page([batch(1, 'x')], 2),
    page([batch(2, 'x'), batch(1, 'y')], 1), page([batch(1, 'x'.repeat(4097))], 1)]) {
    h.respond(data);
    await h.pollSerialLogs();
    assert.equal(h.S.serial.after, 0);
    assert.equal(h.get('serialOutput').textContent, '');
    assert.equal(h.S.serial.pending, false);
    assert.ok(h.S.serial.error.includes('invalid'));
  }
  assert.equal(h.timers.length, 0);
});

test('auto-scroll can be disabled without losing the scroll position', async () => {
  const h = harness();
  h.get('serialAutoscroll').checked = false;
  h.get('serialOutput').scrollTop = 33;
  h.respond(page([batch(1, 'new data')], 1));
  await h.pollSerialLogs();
  assert.equal(h.get('serialOutput').scrollTop, 33);
});

test('the console is the first Settings panel and no log requests run in other views', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  assert.match(html, /data-view="settings">\s*<div class="settings-grid">\s*<article class="panel serial-panel"/);
  const h = harness();
  h.S.view = 'overview';
  await h.pollSerialLogs();
  assert.equal(h.requests.length, 0);
});

test('the device input pattern is valid under modern HTML Unicode-set validation', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  const pattern = /id="serialDevice"[^>]*pattern="([^"]+)"/.exec(html)[1];
  const compiled = new RegExp(`^(?:${pattern})$`, 'v');
  assert.equal(compiled.test('energy-meter_1'), true);
  assert.equal(compiled.test('../bad'), false);
});
