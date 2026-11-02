'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RANGES = {
  '1m': 60000, '5m': 300000, live: 600000, '15m': 900000,
  '30m': 1800000, '1h': 3600000, '6h': 21600000, '24h': 86400000,
  '7d': 604800000, '30d': 2592000000, '90d': 7776000000,
  '180d': 15552000000, '1y': 31536000000, '2y': 63072000000,
  '5y': 157680000000,
};
const NOW = Date.UTC(2030, 0, 1, 12, 34, 56, 789);

// Real isolated SQLite and HTTP handler; no listener, hardware, real clock,
// retention timer, production database, firmware or filesystem fixtures.
function harness(t) {
  let now = NOW;
  let handler;
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
    console: { log() {}, error() {} }, Date: Clock, URL, AbortSignal, Buffer,
    setInterval() {},
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
  const database = run('db');
  t.after(() => { try { database.close(); } catch {} });
  run(`db.exec('DELETE FROM samples'); clearHistory(); state.source = 'device';
    state.sim.running = false; state.startedAt = ${NOW - RANGES['5y'] - 86400000};`);
  return {
    run,
    now: () => now,
    advance(ms) { now += ms; },
    memory(samples, minutes = [], tail = []) {
      context.seconds = samples;
      context.minutes = minutes;
      context.tail = tail;
      run('state.sec = seconds; state.min = minutes; state.minuteTail = tail;');
    },
    persist(samples, source = 'device') {
      context.fixtures = samples;
      context.fixtureSource = source;
      run(`{ const previous = state.source; state.source = fixtureSource;
        fixtures.forEach(dbInsert); state.source = previous; }`);
    },
    unavailable() { run('db.close(); db = null; insertStmt = null;'); },
    traceReads() {
      const reads = [];
      context.recordRead = (sql, args, count) => reads.push({ sql, args, count });
      run(`{ const actual = db; db = {
        prepare(sql) { const stmt = actual.prepare(sql); return {
          all(...args) { const rows = stmt.all(...args); recordRead(sql, args, rows.length); return rows; },
          get(...args) { const row = stmt.get(...args); recordRead(sql, args, row ? 1 : 0); return row; },
        }; },
        exec(sql) { return actual.exec(sql); },
      }; }`);
      return reads;
    },
    async get(range) {
      const url = range === undefined ? '/api/history' : `/api/history?range=${encodeURIComponent(range)}`;
      let status, body;
      await handler({ method: 'GET', url, headers: {} }, {
        writeHead(code) { status = code; },
        end(data) { body = JSON.parse(data); },
      });
      return { status, body };
    },
  };
}

function sample(t, values = {}) {
  return {
    t, seq: t, freq: null, l1: {}, l2: {}, l3: {}, tot: {},
    ...values,
  };
}

test('every rolling range uses exact inclusive timestamps, not sample counts, in memory fallback', async t => {
  const h = harness(t);
  h.unavailable();
  for (const [range, span] of Object.entries(RANGES)) {
    const from = NOW - span;
    h.memory([
      sample(from - 1, { l1: { p: 999 } }),
      sample(from, { l1: { p: 10 } }),
      sample(NOW, { l1: { p: 20 } }),
      sample(NOW + 1, { l1: { p: 999 } }),
    ]);
    const { status, body } = await h.get(range);
    assert.equal(status, 200, range);
    assert.equal(body.range, range);
    assert.equal(body.from, from, range);
    assert.equal(body.to, NOW, range);
    assert.equal(body.span_ms, span, range);
    assert.equal(body.generated_at, NOW, range);
    assert.equal(body.unit, span <= RANGES['1h'] ? 's' : 'min', range);
    assert.equal(body.storage, 'memory', range);
    assert.equal(body.partial, true, range);
    assert.equal(typeof body.warning, 'string', range);
    assert.ok(body.warning.trim().length > 0, range);
    assert.deepEqual(body.points.map(p => [p.t, p.l1.p]), [[from, 10], [NOW, 20]], range);
  }
});

test('unknown, empty and inherited range keys return HTTP 400 while an omitted range defaults to live', async t => {
  const h = harness(t);
  for (const range of ['bogus', '', 'all', '1M', '__proto__', 'constructor', 'toString']) {
    const { status, body } = await h.get(range);
    assert.equal(status, 400, range);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
  }
  const { status, body } = await h.get();
  assert.equal(status, 200);
  assert.equal(body.range, 'live');
  assert.equal(body.span_ms, RANGES.live);
});

test('persisted month and year windows survive empty in-memory buffers with exact SQL cutoffs', async t => {
  const h = harness(t);
  for (const range of ['30d', '90d', '180d', '1y', '2y', '5y']) {
    const from = NOW - RANGES[range];
    h.run("db.exec('DELETE FROM samples')");
    h.persist([
      sample(from - 1, { l1: { p: 999 } }),
      sample(from, { l1: { p: 10 } }),
      sample(NOW, { l1: { p: 20 } }),
      sample(NOW + 1, { l1: { p: 999 } }),
    ]);
    assert.equal(h.run('state.sec.length + state.min.length'), 0);
    const { status, body } = await h.get(range);
    assert.equal(status, 200, range);
    assert.equal(body.storage, 'sqlite', range);
    assert.equal(body.partial, false, range);
    assert.equal(body.warning, undefined, range);
    assert.equal(body.from, from, range);
    assert.equal(body.to, NOW, range);
    assert.equal(body.span_ms, RANGES[range], range);
    assert.deepEqual(body.points.map(p => [p.t, p.l1.p]), [[from, 10], [NOW, 20]], range);
    assert.equal(body.points[0].l2.p, null, range);
  }
});

test('SQLite buckets ignore nulls, preserve extrema and use latest non-null counters by timestamp, not average or max', async t => {
  const h = harness(t);
  h.persist([
    sample(NOW, { freq: 52, l1: { p: 30, vln_min: 210, vln_max: 260, e_wh: null }, tot: { e_wh: 80 } }),
    sample(NOW - 2, { freq: 50, l1: { p: 10, vln_min: 220, vln_max: 240, e_wh: 1000 }, tot: { e_wh: 3000 } }),
    sample(NOW - 1, { l1: { p: null, vln_min: null, vln_max: null, e_wh: 100 }, tot: { e_wh: 500 } }),
  ]);
  const { status, body } = await h.get('5y');
  assert.equal(status, 200);
  assert.equal(body.points.length, 1);
  const [point] = body.points;
  assert.equal(point.t, NOW);
  assert.equal(point.freq, 51);
  assert.equal(point.l1.p, 20);
  assert.equal(point.l1.vln_min, 210);
  assert.equal(point.l1.vln_max, 260);
  assert.equal(point.l1.e_wh, 100);
  assert.equal(point.tot.e_wh, 80);
  assert.equal(point.l2.p, null);
  assert.equal(point.l2.e_wh, null);
  assert.equal(point.tot.q, null);
});

test('memory fallback is time-bucket bounded, chronological and keeps current partial-minute samples without overlapping rollups', async t => {
  const h = harness(t);
  h.unavailable();
  const from = NOW - RANGES['24h'];
  const seconds = Array.from({ length: 2400 }, (_, i) =>
    sample(NOW - RANGES['6h'] + Math.floor(i * (RANGES['6h'] - 1000) / 2399), { l1: { p: 10, e_wh: i } }));
  h.memory(seconds.reverse(), [
    sample(from - 1, { l1: { p: 999 } }),
    sample(from, { l1: { p: 7 } }),
    sample(NOW - RANGES['6h'] - 60000, { l1: { p: 8 } }),
    sample(NOW - RANGES['1h'], { l1: { p: 999 } }),
  ], [sample(NOW, { l1: { p: 42, e_wh: 80 } })]);
  const { status, body } = await h.get('24h');
  assert.equal(status, 200);
  assert.ok(body.points.length <= 720);
  assert.ok(body.points.length > 2);
  assert.equal(body.points[0].t, from);
  assert.equal(body.points[0].l1.p, 7);
  assert.equal(body.points.at(-1).t, NOW);
  assert.equal(body.points.at(-1).l1.e_wh, 80);
  assert.ok(body.points.every(p => p.l1.p <= 42 && p.l2.p === null));
  assert.ok(body.points.every((p, i, points) => i === 0 || p.t > points[i - 1].t));
  assert.equal(body.storage, 'memory');
  assert.equal(body.partial, true);
  assert.ok(body.warning.length > 0);
});

test('a SQLite query failure degrades to bounded available memory with partial status and a warning', async t => {
  const h = harness(t);
  h.persist([sample(NOW - RANGES['30d'], { l1: { p: 999 } })]);
  h.memory([sample(NOW - 1000, { l1: { p: 10 } })], [], [sample(NOW, { l1: { p: 20 } })]);
  h.run('db.close()'); // Keep the non-null handle: exercise a real SQLite read failure.
  const { status, body } = await h.get('5y');
  assert.equal(status, 200);
  assert.equal(body.storage, 'memory');
  assert.equal(body.partial, true);
  assert.equal(body.from, NOW - RANGES['5y']);
  assert.equal(body.to, NOW);
  assert.equal(body.span_ms, RANGES['5y']);
  assert.equal(body.points.length, 1);
  assert.equal(body.points[0].t, NOW);
  assert.equal(body.points[0].l1.p, 15);
  assert.equal(body.points[0].l2.p, null);
  assert.ok(body.warning.trim().length > 0);
});

test('expensive SQLite buckets are briefly cached while exact rolling edges, metadata and current counters stay fresh', async t => {
  const h = harness(t);
  const from = NOW - RANGES['5y'];
  const middle = NOW - RANGES['1y'];
  h.persist([
    sample(from, { l1: { p: 1000, e_wh: 10000 } }),
    sample(from + 10, { l1: { p: 10, e_wh: 100 } }),
    sample(middle, { l1: { p: 11 } }),
    sample(NOW - RANGES['2y'], { l1: { p: 12 } }),
    sample(NOW - RANGES['180d'], { l1: { p: 13 } }),
    sample(NOW, { l1: { p: 20, e_wh: 1000 } }),
  ]);
  const reads = h.traceReads();
  const first = await h.get('5y');
  assert.equal(first.status, 200);
  assert.equal(first.body.points[0].l1.p, 505);
  h.advance(5);
  h.persist([sample(h.now(), { l1: { p: 40, e_wh: 80 } })]);
  const { status, body } = await h.get('5y');
  assert.equal(status, 200);
  assert.equal(body.from, from + 5);
  assert.equal(body.to, h.now());
  assert.equal(body.generated_at, body.to);
  assert.equal(body.to - body.from, body.span_ms);
  assert.equal(body.span_ms, RANGES['5y']);
  assert.equal(body.points[0].t, from + 10);
  assert.equal(body.points[0].l1.p, 10);
  assert.equal(body.points.at(-1).t, h.now());
  assert.equal(body.points.at(-1).l1.p, 30);
  assert.equal(body.points.at(-1).l1.e_wh, 80);
  assert.ok(body.points.every(p => p.t >= body.from && p.t <= body.to));
  assert.equal(reads.filter(r => r.count > 2).length, 1, 'do not re-scan stable interior buckets during the cache lifetime');
  h.advance(15000);
  h.persist([sample(middle + 1, { l1: { p: 21 } })]);
  const refreshed = await h.get('5y');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.points.find(p => p.t === middle + 1).l1.p, 16);
  assert.equal(reads.filter(r => r.count > 2).length, 2, 'refresh interior aggregates after the bounded TTL');
});

test('SQLite queries and warm caches isolate both metrics and retention coverage to the active source', async t => {
  const h = harness(t);
  h.persist([
    sample(NOW - RANGES['5y'] - 1, { l1: { p: 999, e_wh: 9999 } }),
    sample(NOW, { l1: { p: 999, e_wh: 9999 } }),
  ], 'simulation');
  h.persist([sample(NOW - 1, { l1: { p: 10, e_wh: 100 } })]);
  const device = await h.get('5y');
  assert.equal(device.status, 200);
  assert.equal(device.body.storage, 'sqlite');
  assert.equal(device.body.partial, true);
  assert.deepEqual(device.body.points.map(p => [p.l1.p, p.l1.e_wh]), [[10, 100]]);
  h.run("state.source = 'simulation'");
  const simulation = await h.get('5y');
  assert.equal(simulation.body.partial, false);
  assert.deepEqual(simulation.body.points.map(p => [p.l1.p, p.l1.e_wh]), [[999, 9999]]);
  h.run("state.source = 'device'");
  const cachedDevice = await h.get('5y');
  assert.deepEqual(cachedDevice.body, device.body);
});

test('all SQLite ranges return at most 720 real, ordered, in-window sample timestamps using read-only bounded queries', async t => {
  const h = harness(t);
  const reads = h.traceReads();
  for (const [range, span] of Object.entries(RANGES)) {
    const from = NOW - span;
    h.run("db.exec('DELETE FROM samples')");
    const fixtures = Array.from({ length: 1800 }, (_, i) =>
      sample(from + Math.floor(i * span / 1799), { l1: { p: 10, e_wh: i } }));
    h.persist([
      sample(from - 1, { l1: { p: 999 } }),
      ...fixtures.reverse(),
      sample(NOW + 1, { l1: { p: 999 } }),
    ]);
    const { status, body } = await h.get(range);
    assert.equal(status, 200, range);
    assert.equal(body.storage, 'sqlite', range);
    assert.equal(body.partial, false, range);
    assert.equal(body.from, from, range);
    assert.equal(body.to, NOW, range);
    assert.equal(body.generated_at, NOW, range);
    assert.equal(body.to - body.from, body.span_ms, range);
    assert.ok(body.points.length > 1 && body.points.length <= 720, range);
    const actualTimes = new Set(fixtures.map(p => p.t));
    assert.ok(body.points.every((p, i, points) => Number.isFinite(p.t) && actualTimes.has(p.t)
      && p.t >= from && p.t <= NOW && (i === 0 || p.t > points[i - 1].t)), range);
    assert.ok(body.points.every(p => p.l1.p === 10 && p.l2.p === null), range);
    assert.equal(body.points.at(-1).l1.e_wh, 1799, range);
  }
  assert.ok(reads.length > 0);
  assert.ok(reads.every(r => /^\s*(SELECT|WITH)\b/.test(r.sql)), 'history never writes the database');
  assert.ok(reads.every(r => r.count <= 720), 'raw sample sets never cross the SQLite/JS boundary');
});

test('empty history and recording that began inside the requested window never create synthetic points', async t => {
  const h = harness(t);
  for (const range of Object.keys(RANGES)) {
    const { status, body } = await h.get(range);
    assert.equal(status, 200, range);
    assert.equal(body.storage, 'sqlite', range);
    assert.equal(body.partial, true, range);
    assert.deepEqual(body.points, [], range);
    assert.equal(body.from, NOW - RANGES[range], range);
    assert.equal(body.to, NOW, range);
  }
  h.persist([sample(NOW - 1, { l1: { p: 10 } })]);
  const recorded = await h.get('5y');
  assert.equal(recorded.body.partial, true);
  assert.equal(recorded.body.points.length, 1);
  assert.equal(recorded.body.points[0].t, NOW - 1);
  h.unavailable();
  const fallback = await h.get('5y');
  assert.equal(fallback.status, 200);
  assert.deepEqual(fallback.body.points, []);
  assert.equal(fallback.body.storage, 'memory');
  assert.equal(fallback.body.partial, true);
  assert.ok(fallback.body.warning.length > 0);
});

test('fallback never re-labels source-ambiguous pre-boot SQLite buffer rows as current-source memory', async t => {
  const h = harness(t);
  h.run(`state.startedAt = ${NOW - 1000}`);
  h.persist([sample(NOW - 2000, { l1: { p: 999 } })], 'simulation');
  h.persist([sample(NOW - 1500, { l1: { p: 10 } })]);
  h.run('loadHistoryFromDb()'); // Existing boot buffers do not retain source tags.
  h.run(`pushSample(${JSON.stringify(sample(NOW, { l1: { p: 20 } }))})`);
  h.run('db.close()');
  const { status, body } = await h.get('live');
  assert.equal(status, 200);
  assert.equal(body.storage, 'memory');
  assert.equal(body.partial, true);
  assert.ok(body.warning.length > 0);
  assert.deepEqual(body.points.map(p => [p.t, p.l1.p]), [[NOW, 20]]);
});

test('SQLite history includes partial-minute samples even before a minute rollup exists', async t => {
  const h = harness(t);
  for (let i = 0; i < 7; i++) {
    h.run(`pushSample(${JSON.stringify(sample(NOW - 6000 + i * 1000, { l1: { p: i, e_wh: i } }))})`);
  }
  assert.equal(h.run('state.min.length'), 0);
  assert.equal(h.run('state.minuteTail.length'), 7);
  for (const range of ['6h', '30d', '1y']) {
    const { status, body } = await h.get(range);
    assert.equal(status, 200);
    assert.equal(body.storage, 'sqlite');
    assert.ok(body.points.length > 0);
    assert.equal(body.points.at(-1).t, NOW);
    assert.equal(body.points.at(-1).l1.e_wh, 6);
  }
});

test('a bucket rollover during the cache lifetime re-clips both bounds without duplicated or expired points', async t => {
  const h = harness(t);
  const from = NOW - RANGES.live;
  h.persist([
    sample(from, { l1: { p: 999 } }),
    sample(from + 500, { l1: { p: 999 } }),
    sample(from + 1100, { l1: { p: 10 } }),
    sample(from + 1600, { l1: { p: 10 } }),
    sample(from + 2100, { l1: { p: 10 } }),
    sample(NOW, { l1: { p: 10, e_wh: 1000 } }),
  ]);
  assert.equal((await h.get('live')).status, 200);
  h.advance(1000);
  h.persist([sample(h.now(), { l1: { p: 10, e_wh: 80 } })]);
  const { status, body } = await h.get('live');
  assert.equal(status, 200);
  assert.equal(body.from, from + 1000);
  assert.equal(body.to, h.now());
  assert.equal(body.to - body.from, body.span_ms);
  assert.equal(body.generated_at, body.to);
  assert.ok(body.points.every((p, i, points) => p.t >= body.from && p.t <= body.to
    && (i === 0 || p.t > points[i - 1].t) && p.l1.p === 10));
  assert.equal(body.points.at(-1).t, h.now());
  assert.equal(body.points.at(-1).l1.e_wh, 80);
});

test('a warm SQLite cache cannot conceal a subsequent storage failure', async t => {
  const h = harness(t);
  h.persist([sample(NOW - RANGES['1y'], { l1: { p: 999 } })]);
  assert.equal((await h.get('5y')).body.storage, 'sqlite');
  h.memory([sample(NOW, { l1: { p: 10 } })]);
  h.run('db.close()');
  h.advance(1);
  const { status, body } = await h.get('5y');
  assert.equal(status, 200);
  assert.equal(body.storage, 'memory');
  assert.equal(body.partial, true);
  assert.ok(body.warning.length > 0);
  assert.equal(body.from, h.now() - RANGES['5y']);
  assert.equal(body.to, h.now());
  assert.deepEqual(body.points.map(p => [p.t, p.l1.p]), [[NOW, 10]]);
});

test('latest counter ties use the latest actual row even when the counter resets at the same timestamp', async t => {
  const h = harness(t);
  h.persist([
    sample(NOW, { l1: { e_wh: 1000 }, tot: { e_wh: 3000 } }),
    sample(NOW, { l1: { e_wh: 80 }, tot: { e_wh: 240 } }),
  ]);
  const { status, body } = await h.get('1y');
  assert.equal(status, 200);
  assert.equal(body.points.length, 1);
  assert.equal(body.points[0].l1.e_wh, 80);
  assert.equal(body.points[0].tot.e_wh, 240);
});

test('aggregate cache has a fixed entry bound and does not grow for invalid ranges', async t => {
  const h = harness(t);
  for (let i = 0; i < 40; i++) {
    // Exercise the bound independently of the two sources normally allowed by
    // /api/source; no HTTP state changes are made by this test.
    h.run(`state.source = 'test-source-${i}'`);
    assert.equal((await h.get('5y')).status, 200);
    assert.ok(h.run('historyCache.size') <= 32);
  }
  const size = h.run('historyCache.size');
  assert.equal(size, 32);
  for (let i = 0; i < 5; i++) assert.equal((await h.get(`invalid-${i}`)).status, 400);
  assert.equal(h.run('historyCache.size'), size);
});
