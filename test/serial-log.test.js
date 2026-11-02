'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Actual HTTP + actual SQLite; no fixtures are sent to the live 8090 service.
function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-serial-log-'));
  const children = [];
  t.after(async () => {
    for (const child of children) await child.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, async start(env = {}) {
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
        ESP32_URL: '', ESP32_DEVICE_ID: 'energymeter',
        DB_PATH: path.join(dir, 'meter.db'), OTA_DIR: path.join(dir, 'firmware'),
        DB_RETENTION_DAYS: '0', OTA_TOKEN: 'serial-test-token', INGEST_TOKEN: 'ingest-test-token',
        OTA_ALLOW_CIDRS: '100.64.0.0/10,127.0.0.1/32', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    const server = {
      base: `http://127.0.0.1:${port}`,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const ended = once(child, 'exit');
        child.kill('SIGTERM');
        await ended;
      },
      async request(method, url, body, headers = {}) {
        const response = await fetch(server.base + url, {
          method, headers, body, signal: AbortSignal.timeout(4000),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers: response.headers, bytes,
          text: bytes.toString('utf8'), json() { return JSON.parse(bytes); } };
      },
      post(body, extra = {}) {
        return server.request('POST', '/api/serial-log', body, { ...logHeaders(), ...extra });
      },
      get(query = '') { return server.request('GET', '/api/serial-log' + query); },
    };
    children.push(server);
    const deadline = Date.now() + 5000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
      try {
        const r = await server.request('GET', '/api/status');
        if (r.status === 200) break;
      } catch (error) {
        if (Date.now() >= deadline) throw new Error(`Test server failed to start: ${error.message} ${output}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return server;
  } };
}

function logHeaders() {
  return { 'Content-Type': 'text/plain; charset=utf-8', 'X-OTA-Token': 'serial-test-token',
    'X-Device-Name': 'energymeter', 'X-Firmware-Version': '1.3.3',
    'X-Log-Boot-ID': 'boot-1234', 'X-Log-Sequence': '0', 'X-Log-Dropped-Bytes': '12' };
}

test('serial-log accepts raw UTF-8 and serves unchanged console text without HTML execution', async t => {
  const server = await harness(t).start();
  const text = '\uFEFF  I (42) boot: café ⚡\r\n\u001b[31mERROR\u001b[0m\n<script>alert(1)</script>\0tail  ';
  const r = await server.post(Buffer.from(text));
  assert.equal(r.status, 200, r.text);
  const logs = await server.get();
  assert.equal(logs.status, 200, logs.text);
  const [batch] = logs.json().batches;
  assert.equal(batch.text, text);
  assert.equal(batch.device_name, 'energymeter');
  assert.equal(batch.firmware_version, '1.3.3');
  assert.equal(batch.boot_id, 'boot-1234');
  assert.equal(batch.sequence, '0');
  assert.equal(batch.dropped_bytes, '12');
  assert.ok(batch.received_at > 0);
  const raw = await server.get('?format=text');
  assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(raw.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(raw.bytes, Buffer.from(text));
});

test('serial-log enforces the 4096-byte limit and returns HTTP 413 rather than resetting the connection', async t => {
  const server = await harness(t).start();
  assert.equal((await server.post(Buffer.alloc(4096, 0x41))).status, 200);
  const tooLarge = await server.post(Buffer.alloc(4097, 0x42), { 'X-Log-Sequence': '1' });
  assert.equal(tooLarge.status, 413);
  // Count encoded bytes, not JavaScript characters.
  assert.equal((await server.post('⚡'.repeat(1366), { 'X-Log-Sequence': '2' })).status, 413);
  assert.equal((await server.get()).json().batches.length, 1);
});

test('retries are deduplicated durably by device, boot and sequence; conflicting bytes never overwrite', async t => {
  const h = harness(t);
  const server = await h.start();
  const first = await server.post('first\r\n');
  const retries = await Promise.all(Array.from({ length: 8 }, () => server.post('first\r\n')));
  for (const retry of retries) {
    assert.equal(retry.status, 200);
    assert.equal(retry.json().id, first.json().id);
    assert.equal(retry.json().duplicate, true);
  }
  const original = (await server.get()).json().batches[0];
  assert.equal((await server.post('changed')).status, 409);
  assert.equal((await server.get()).json().batches.length, 1);
  await server.stop();
  const restarted = await h.start();
  assert.deepEqual((await restarted.get()).json().batches[0], original);
  assert.equal((await restarted.post('first\r\n')).json().duplicate, true);
  assert.equal((await restarted.post('new boot', { 'X-Log-Boot-ID': 'boot-other' })).status, 200);
  assert.equal((await restarted.post('other device', { 'X-Device-Name': 'other-esp32' })).status, 200);
  assert.equal((await restarted.get()).json().batches.length, 2);
  assert.equal((await restarted.get('?device=other-esp32')).json().batches.length, 1);
});

test('serial-log requires the existing OTA token, fails closed when unset and enforces the tailnet policy', async t => {
  const server = await harness(t).start();
  for (const token of ['', 'wrong']) {
    assert.equal((await server.post('secret', { 'X-OTA-Token': token })).status, 401);
  }
  const noToken = await harness(t).start({ OTA_TOKEN: '' });
  assert.equal((await noToken.post('secret')).status, 401);
  assert.equal((await server.get()).json().batches.length, 0);
  const privateOnly = await harness(t).start({ OTA_ALLOW_CIDRS: '100.64.0.0/10' });
  assert.equal((await privateOnly.post('secret', { 'X-Forwarded-For': '100.72.135.8' })).status, 403);
  assert.equal((await privateOnly.get()).status, 403);
});

test('serial-log validates all metadata without losing 64-bit counter precision', async t => {
  const server = await harness(t).start();
  for (const name of ['X-Device-Name', 'X-Firmware-Version', 'X-Log-Boot-ID', 'X-Log-Sequence', 'X-Log-Dropped-Bytes']) {
    assert.equal((await server.post('x', { [name]: '' })).status, 400, name);
  }
  for (const extra of [
    { 'X-Device-Name': '../invalid' }, { 'X-Device-Name': 'a'.repeat(65) },
    { 'X-Log-Boot-ID': '<script>' }, { 'X-Log-Boot-ID': 'a'.repeat(129) },
    { 'X-Firmware-Version': '1.2' }, { 'X-Firmware-Version': '1.3.65536' },
    { 'X-Log-Sequence': '-1' }, { 'X-Log-Sequence': '01' }, { 'X-Log-Sequence': '1.5' },
    { 'X-Log-Sequence': '18446744073709551616' }, { 'X-Log-Dropped-Bytes': 'not-a-number' },
  ]) assert.equal((await server.post('x', extra)).status, 400, JSON.stringify(extra));
  assert.equal((await server.get()).json().batches.length, 0);
  const max = '18446744073709551615';
  assert.equal((await server.post('x', { 'X-Log-Sequence': max, 'X-Log-Dropped-Bytes': max })).status, 200);
  const [batch] = (await server.get()).json().batches;
  assert.equal(batch.sequence, max);
  assert.equal(batch.dropped_bytes, max);
});

test('console bodies must be UTF-8 plain text, never parsed as JSON or stripped of whitespace', async t => {
  const server = await harness(t).start();
  for (const type of ['application/json', 'text/html', 'text/plain', 'text/plain; charset=latin1']) {
    assert.equal((await server.post('{}', { 'Content-Type': type })).status, 415);
  }
  assert.equal((await server.post('{}', { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await server.post(Buffer.from([0xff, 0xfe]))).status, 400);
  const text = '  {"lines":["not JSON to the receiver"]}\r\n  ';
  assert.equal((await server.post(text)).status, 200);
  assert.equal((await server.get()).json().batches[0].text, text);
  assert.equal((await server.post('', { 'X-Log-Sequence': '1' })).status, 200);
});

test('cursor pagination preserves partial lines and out-of-order sequence numbers', async t => {
  const server = await harness(t).start();
  for (const [seq, text] of [['2', 'hel'], ['0', 'lo\r'], ['1', '\n']]) {
    assert.equal((await server.post(text, { 'X-Log-Sequence': seq })).status, 200);
  }
  const first = (await server.get('?limit=2')).json();
  assert.deepEqual(first.batches.map(b => b.text), ['hel', 'lo\r']);
  assert.equal(first.has_more, true);
  const next = (await server.get(`?after=${first.next_after}&limit=2`)).json();
  assert.deepEqual(next.batches.map(b => b.text), ['\n']);
  assert.equal(next.has_more, false);
  const empty = (await server.get(`?after=${next.next_after}`)).json();
  assert.equal(empty.next_after, next.next_after);
  assert.deepEqual(empty.batches, []);
  const raw = await server.get('?format=text');
  assert.equal(raw.text, 'hello\r\n');
  assert.equal(raw.headers.get('x-log-next-after'), String(next.next_after));
  assert.equal(raw.headers.get('x-log-has-more'), 'false');
  for (const query of ['?after=-1', '?after=9007199254740992', '?after=1%0A', '?limit=1%0A',
    '?limit=0', '?limit=201', '?format=html', '?device=../bad']) {
    assert.equal((await server.get(query)).status, 400, query);
  }
});

test('chunked uploads cannot bypass the byte limit', async t => {
  const server = await harness(t).start();
  async function* chunks() { yield Buffer.alloc(2048, 0x41); yield Buffer.alloc(2049, 0x41); }
  const response = await fetch(server.base + '/api/serial-log', {
    method: 'POST', headers: logHeaders(), body: chunks(), duplex: 'half', signal: AbortSignal.timeout(4000),
  });
  assert.equal(response.status, 413);
  await response.text();
  assert.equal((await server.get()).json().batches.length, 0);
});

test('logs never clear a meter alarm, create a measurement or activate the OTA feed', async t => {
  const server = await harness(t).start();
  await server.request('POST', '/api/ingest', JSON.stringify({ meter: {
    adapter_connected: false, has_sample: false, stale: true, last_error: 'disconnected',
  } }), { 'Content-Type': 'application/json', 'X-Ingest-Token': 'ingest-test-token' });
  const before = (await server.request('GET', '/api/status')).json();
  assert.equal(before.device.health.code, 'adapter_disconnected');
  await server.post('I (10) console output only\n');
  const after = (await server.request('GET', '/api/status')).json();
  assert.deepEqual(after.device.health, before.device.health);
  assert.equal(after.device.last_seen, before.device.last_seen);
  assert.equal(after.device.last_sample_at, before.device.last_sample_at);
  assert.deepEqual(after.buffers, before.buffers);
  assert.equal(after.ota.enabled, false);
});

test('storage failures are not acknowledged as accepted logs', async t => {
  const h = harness(t);
  const server = await h.start({ DB_PATH: h.dir }); // a directory is not a SQLite database
  assert.equal((await server.post('must be retried')).status, 503);
  assert.equal((await server.get()).status, 503);
});
