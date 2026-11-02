'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function clientHarness(fetcher = async () => ({ ok: true, json: async () => ({ points: [] }) })) {
  const elements = new Map(), drawn = [];
  const ctx = Object.fromEntries(['save', 'restore', 'beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'stroke', 'setLineDash']
    .map(name => [name, (...args) => drawn.push([name, ...args])]));
  const element = id => ({ id, textContent: '', hidden: false, value: 'live',
    style: { setProperty() {} }, dataset: {}, classList: { toggle() {} },
    selectedOptions: [{ textContent: 'Selected range' }],
    addEventListener(type, fn) { this[type] = fn; }, setAttribute() {}, append() {},
  });
  const get = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  class Chart {
    constructor(canvas, config) {
      this.canvas = canvas; this.config = config; this.options = config.options;
      this.data = config.data; this.ctx = ctx;
      this.chartArea = { left: 10, right: 210, top: 20, bottom: 120 };
    }
    update() {}
  }
  const context = vm.createContext({
    document: { getElementById: get, querySelectorAll: () => [], documentElement: element('root'), createElement: () => element('new') },
    localStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#8b98a5' }),
    Chart, Intl, Date, AbortSignal, AbortController, URLSearchParams,
    setTimeout() { return 1; }, clearTimeout() {}, fetch: fetcher,
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  vm.runInContext(source.replace('  boot();',
    '  globalThis.client = { S, baseChartOptions, createChartFor, charts, fetchHistory, fmtAxisTime, energyBuckets, bindControls, updateCharts };'), context);
  return { ...context.client, get, drawn, context };
}

test('chart tooltip formats Intl number formatters instead of calling them as functions', () => {
  const h = clientHarness();
  const format = h.baseChartOptions().plugins.tooltip.callbacks.label;
  const label = format({ dataset: { label: 'L1', unitFmt: new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }), unitLabel: 'V' }, parsed: { y: 230.5 } });
  assert.equal(label.trim(), 'L1: 230.5 V');
  const missing = format({ dataset: { label: 'L2', unitLabel: 'A' }, parsed: { y: null } });
  assert.equal(missing.trim(), 'L2: — A');
});

test('time-series and energy charts draw a bounded hover/touch crosshair that clears on exit', () => {
  const h = clientHarness();
  for (const id of ['overviewPowerChart', 'powerPChart', 'voltageLnChart', 'currentDChart', 'freqChart', 'energyBarChart']) {
    const chart = h.createChartFor(id);
    const plugin = chart.config.plugins?.find(p => p.id === 'chart-cursor');
    assert.ok(plugin, id + ' has a cursor plugin');
    const args = { event: { type: 'mousemove', x: 60, y: 70 }, inChartArea: true };
    plugin.afterEvent(chart, args);
    assert.equal(args.changed, true);
    h.drawn.length = 0;
    plugin.afterDatasetsDraw(chart);
    assert.deepEqual(h.drawn.filter(call => call[0] === 'moveTo'), [['moveTo', 60, 20], ['moveTo', 10, 70]]);
    assert.deepEqual(h.drawn.filter(call => call[0] === 'lineTo'), [['lineTo', 60, 120], ['lineTo', 210, 70]]);
    for (const event of [
      { type: 'mouseout', x: 60, y: 70 }, { type: 'touchend', x: 60, y: 70 },
      { type: 'touchcancel', x: 60, y: 70 }, { type: 'mousemove', x: 500, y: 70 },
    ]) {
      plugin.afterEvent(chart, { event, inChartArea: true });
      h.drawn.length = 0;
      plugin.afterDatasetsDraw(chart);
      assert.equal(h.drawn.length, 0, event.type);
    }
    plugin.afterEvent(chart, { event: { type: 'touchmove', x: 80, y: 90 }, inChartArea: true });
    h.drawn.length = 0;
    plugin.afterDatasetsDraw(chart);
    assert.ok(h.drawn.some(call => call[0] === 'stroke'));
    assert.ok(chart.options.events.includes('touchend'));
  }
});

test('compatibility mouse events after a touch release do not revive the cursor', () => {
  const h = clientHarness(), chart = h.createChartFor('overviewPowerChart');
  const plugin = chart.config.plugins.find(p => p.id === 'chart-cursor');
  plugin.afterEvent(chart, { event: { type: 'mousedown', native: { type: 'touchstart' }, x: 60, y: 70 }, inChartArea: true });
  assert.ok(chart.$cursor);
  plugin.afterEvent(chart, { event: { type: 'mouseup', native: { type: 'touchend' }, x: 60, y: 70 }, inChartArea: true });
  assert.equal(chart.$cursor, null);
  for (const type of ['mousemove', 'click']) {
    plugin.afterEvent(chart, { event: { type, native: { type, sourceCapabilities: { firesTouchEvents: true } }, x: 60, y: 70 }, inChartArea: true });
    assert.equal(chart.$cursor, null, type);
  }
  plugin.afterEvent(chart, { event: { type: 'touchmove', x: 80, y: 90 }, inChartArea: true });
  assert.ok(chart.$cursor);
});

function point(t, e = 0) {
  return { t, freq: 50, l1: { p: 100, e_wh: e }, l2: { p: 200, e_wh: e },
    l3: { p: 300, e_wh: e }, tot: { p: 600, e_wh: e * 3 } };
}

test('the range selector offers minutes, days, months and years while Live stays the default', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  const select = html.match(/<select id="rangeSelect"[\s\S]*?<\/select>/)[0];
  for (const key of ['1m', '5m', 'live', '15m', '30m', '1h', '6h', '24h', '7d', '30d', '90d', '180d', '1y', '2y', '5y']) {
    assert.ok(select.includes(`value="${key}"`), key);
  }
  assert.match(select, /value="live"[^>]*selected/);
});

test('history uses the requested time window even when only recent points have been recorded', async () => {
  const to = Date.UTC(2026, 10, 3), from = to - 365 * 86400e3;
  const points = [point(to - 60000), point(to - 1000, 5)];
  const h = clientHarness(async () => ({ ok: true, json: async () => ({ range: '1y', from, to, span_ms: to - from, storage: 'sqlite', partial: false, points }) }));
  const chart = h.createChartFor('overviewPowerChart');
  h.charts.set('overviewPowerChart', chart);
  h.S.range = '1y';
  await h.fetchHistory(true);
  assert.equal(h.S.lastHistorySpan, to - from);
  assert.equal(chart.options.scales.x.min, from);
  assert.equal(chart.options.scales.x.max, to);
  assert.equal(chart.data.datasets[0].data.length, 2);
  assert.match(h.get('historySummary').textContent, /2 points/);
});

test('yearly energy charts use calendar-month buckets and ignore missing/reset counters', () => {
  const h = clientHarness();
  const points = [point(Date.UTC(2026, 0, 1), 100), point(Date.UTC(2026, 0, 2), 110),
    point(Date.UTC(2026, 0, 3), 0), point(Date.UTC(2026, 0, 4), 5)];
  points[3].l2.e_wh = null;
  const buckets = h.energyBuckets(points, '1y');
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].t0, Date.UTC(2026, 0, 1));
  assert.equal(buckets[0].t1, Date.UTC(2026, 1, 1));
  assert.equal(buckets[0].e.l1, 15);
  assert.equal(buckets[0].e.l2, 10);
  h.createChartFor('energyBarChart');
  h.S.range = '1y';
  h.updateCharts(points);
  assert.equal(h.get('energyChartTitle').textContent, 'Energy per month');
});

test('cursor readouts use chart-specific units including current demand and frequency', () => {
  const h = clientHarness();
  for (const [id, unit] of [['currentDChart', 'A'], ['voltageLnChart', 'V'], ['powerQChart', 'var'], ['powerSChart', 'VA'], ['freqChart', 'Hz']]) {
    const chart = h.createChartFor(id);
    assert.equal(chart.options.scales.y.title.text, unit, id);
    assert.equal(chart.data.datasets[0].unitLabel, unit, id);
    const label = chart.options.plugins.tooltip.callbacks.label({ dataset: chart.data.datasets[0], parsed: { y: 50 } });
    assert.ok(label.endsWith(' ' + unit), id);
  }
  h.updateCharts([point(Date.UTC(2026, 0, 1))]);
  assert.equal(h.charts.get('freqChart').data.datasets[0].data[0].y, 50);
});

test('a late response for an old range cannot replace the newly selected history', async () => {
  const requests = [];
  const h = clientHarness(url => new Promise(resolve => requests.push({ url, resolve })));
  const to = Date.UTC(2026, 10, 3);
  h.S.range = '1m';
  const old = h.fetchHistory(true);
  h.S.range = '1y';
  const current = h.fetchHistory(true);
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true, json: async () => ({ range: '1y', from: to - 365 * 86400e3, to, points: [point(to - 1000, 20)] }) });
  await current;
  requests[0].resolve({ ok: true, json: async () => ({ range: '1m', from: to - 60000, to, points: [point(to - 500, 1)] }) });
  await old;
  assert.equal(h.S.lastHistory[0].l1.e_wh, 20);
  assert.equal(h.S.lastHistorySpan, 365 * 86400e3);
  assert.equal(h.S.historyPending, false);
});

test('empty, partial and failed history are explicit without fabricating data or replacing connection feedback', async () => {
  const to = Date.UTC(2026, 10, 3), from = to - 600000;
  const h = clientHarness(async () => ({ ok: true, json: async () => ({ range: 'live', from, to, points: [] }) }));
  h.get('noticeText').textContent = 'Meter fault remains visible';
  Object.defineProperty(h.get('historySummary'), 'innerHTML', { set() { throw new Error('History text must not be HTML'); } });
  await h.fetchHistory(true);
  assert.deepEqual(Array.from(h.S.lastHistory), []);
  assert.match(h.get('historySummary').textContent, /No recorded data/);
  h.context.fetch = async () => ({ ok: true, json: async () => ({ range: 'live', from, to, points: [point(to - 1000)], partial: true, warning: '<script>not executable</script>' }) });
  await h.fetchHistory(true);
  assert.equal(h.get('historyStatus').dataset.state, 'partial');
  assert.ok(h.get('historySummary').textContent.includes('<script>not executable</script>'));
  h.context.fetch = async () => ({ ok: false, status: 503 });
  await h.fetchHistory(true);
  assert.equal(h.S.lastHistory.length, 1);
  assert.equal(h.get('historyStatus').dataset.state, 'error');
  assert.match(h.get('historySummary').textContent, /HTTP 503/);
  assert.equal(h.get('noticeText').textContent, 'Meter fault remains visible');
});

test('a lone recorded point remains visible in a long time window', () => {
  const h = clientHarness();
  const chart = h.createChartFor('overviewPowerChart');
  h.charts.set('overviewPowerChart', chart);
  h.updateCharts([point(Date.UTC(2026, 10, 3))]);
  assert.equal(chart.data.datasets[0].pointRadius, 3);
  h.updateCharts([point(Date.UTC(2026, 10, 2)), point(Date.UTC(2026, 10, 3))]);
  assert.equal(chart.data.datasets[0].pointRadius, 0);
});

test('non-chart views and paused automatic polling do not request history', async () => {
  let calls = 0;
  const h = clientHarness(async () => { calls++; return { ok: true, json: async () => ({ points: [] }) }; });
  h.S.view = 'settings';
  await h.fetchHistory(true);
  h.S.view = 'table';
  await h.fetchHistory(true);
  h.S.view = 'overview'; h.S.paused = true;
  await h.fetchHistory();
  assert.equal(calls, 0);
  await h.fetchHistory(true);
  assert.equal(calls, 1);
});
