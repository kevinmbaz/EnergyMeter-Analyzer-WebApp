'use strict';

/* TPM-04-100D Energy Analytics — client app.
   GUI phase: consumes /api/readings + /api/history from the Node server
   (currently fed by the built-in simulator; ESP32 comes in phase 2). */

(() => {
  const $ = id => document.getElementById(id);
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  const PHASES = ['l1', 'l2', 'l3'];
  const RANGE_SPANS = { '1m': 60e3, '5m': 300e3, live: 600e3, '15m': 900e3, '30m': 1800e3,
    '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3,
    '30d': 30 * 86400e3, '90d': 90 * 86400e3, '180d': 180 * 86400e3,
    '1y': 365 * 86400e3, '2y': 2 * 365 * 86400e3, '5y': 5 * 365 * 86400e3 };
  const PHASE_COLOR_KEY = { l1: '--p1', l2: '--p2', l3: '--p3', total: '--muted', accent: '--accent' };

  const S = {
    theme: localStorage.getItem('emTheme') || 'dark',
    pollMs: Number(localStorage.getItem('emPollMs')) || 2000,
    range: 'live',
    paused: false,
    online: false,
    latest: null,
    meta: null,
    view: 'overview',
    phasesOn: { l1: true, l2: true, l3: true, total: true },
    provisionalShown: false,
    deviceBanner: false,
    otaStagedVersion: null,
    serial: serialState(''),
    rings: { power: [], energy: [], pf: [], freq: [], current: [], imbalance: [] },
    chartSpecs: [],          // {chart, series:[{phase,key,colorKey,label,...}]}
    lastHistory: null,
    lastHistoryFetch: 0,
    historyRequest: 0,
    historyPending: false,
    historyWindow: null,
    timer: null,
    noticeTimer: null,
  };

  // ---------------------------------------------------------------- formatting

  const nf = (min, max) => new Intl.NumberFormat(undefined, { minimumFractionDigits: min, maximumFractionDigits: max });
  const fmt = { kW: nf(2, 2), V: nf(1, 1), A: nf(2, 2), W: nf(0, 0), pf: nf(3, 3), Hz: nf(2, 2), pct: nf(1, 1) };
  const fmtKw = v => fmt.kW.format(v / 1000);
  const fmtKwh = v => (v / 1000 < 10 ? nf(3, 3) : nf(2, 2)).format(v / 1000);
  const fmtKvar = v => fmt.kW.format(v / 1000);
  const fmtKva = v => fmt.kW.format(v / 1000);

  function fmtAxisTime(t, spanMs) {
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (spanMs <= 2 * 3600e3) return `${hm}:${String(d.getSeconds()).padStart(2, '0')}`;
    if (spanMs <= 30 * 3600e3) return hm;
    if (spanMs <= 14 * 86400e3) return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`;
    if (spanMs <= 180 * 86400e3) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  function fmtTooltipTime(t) {
    return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtClock(t) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
  function fmtUptime(ms) {
    const h = Math.floor(ms / 3600e3), m = Math.floor(ms % 3600e3 / 60e3);
    return `${h}h ${m}m`;
  }
  const fmtBytes = b => b == null ? '—'
    : b < 1024 ? `${b} B`
    : b < 1048576 ? `${(b / 1024).toFixed(1)} KB`
    : `${(b / 1048576).toFixed(1)} MB`;
  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = parseInt(v, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const finite = v => typeof v === 'number' && Number.isFinite(v);

  // ---------------------------------------------------------------- chart engine

  const chartPalette = () => {
    const c = {
      p1: cssVar('--p1'), p2: cssVar('--p2'), p3: cssVar('--p3'),
      accent: cssVar('--accent'), muted: cssVar('--muted'), faint: cssVar('--faint'),
      line: cssVar('--line'), ink: cssVar('--ink'), panel: cssVar('--panel'),
    };
    // Series defs address colors by their CSS variable name ('--p1'); expose
    // both spellings so lookups never silently fall back to the accent color.
    c['--p1'] = c.p1; c['--p2'] = c.p2; c['--p3'] = c.p3;
    c['--accent'] = c.accent; c['--muted'] = c.muted; c['--faint'] = c.faint;
    return c;
  };

  const CURSOR_EVENTS = ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend', 'touchcancel'];
  const chartCursor = {
    id: 'chart-cursor', events: CURSOR_EVENTS,
    afterEvent(chart, args) {
      const event = args.event, area = chart.chartArea;
      const type = event.native?.type || event.type;
      if (type === 'touchend' || type === 'touchcancel') chart.$cursorTouchUntil = Date.now() + 1000;
      // Browsers synthesize mouse/click events after a tap. Do not revive the
      // released crosshair, including when Chart.js replays that event on update.
      const touchMouse = !type.startsWith('touch') && (event.native?.sourceCapabilities?.firesTouchEvents
        || Date.now() < (chart.$cursorTouchUntil || 0) || (args.replay && chart.$cursorTouchUntil));
      if (!type.startsWith('touch') && !touchMouse) chart.$cursorTouchUntil = 0;
      const inside = area && args.inChartArea !== false && !touchMouse
        && !['mouseout', 'touchend', 'touchcancel'].includes(type)
        && finite(event.x) && finite(event.y)
        && event.x >= area.left && event.x <= area.right
        && event.y >= area.top && event.y <= area.bottom;
      const next = inside ? { x: event.x, y: event.y } : null;
      if (chart.$cursor?.x !== next?.x || chart.$cursor?.y !== next?.y) {
        chart.$cursor = next;
        args.changed = true;
      }
    },
    afterDatasetsDraw(chart) {
      const point = chart.$cursor, area = chart.chartArea;
      if (!point || !area || point.x < area.left || point.x > area.right
          || point.y < area.top || point.y > area.bottom) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      ctx.clip();
      ctx.strokeStyle = cssVar('--muted');
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(point.x, area.top); ctx.lineTo(point.x, area.bottom);
      ctx.moveTo(area.left, point.y); ctx.lineTo(area.right, point.y);
      ctx.stroke();
      ctx.restore();
    },
  };

  function baseChartOptions() {
    const c = chartPalette();
    return {
      maintainAspectRatio: false,
      animation: { duration: 350 },
      interaction: { mode: 'index', axis: 'x', intersect: false },
      events: CURSOR_EVENTS,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.panel, titleColor: c.ink, bodyColor: c.muted,
          borderColor: c.line, borderWidth: 1, padding: 10, cornerRadius: 8,
          titleFont: { weight: '600', size: 11.5 }, bodyFont: { size: 12 },
          callbacks: {
            title: items => items.length ? fmtTooltipTime(items[0].parsed.x) : '',
            label: ctx => {
              const formatter = ctx.dataset.unitFmt, value = ctx.parsed.y;
              const text = !finite(value) ? '—' : typeof formatter === 'function'
                ? formatter(value) : formatter?.format ? formatter.format(value) : String(value);
              return ` ${ctx.dataset.label}: ${text}${ctx.dataset.unitLabel ? ` ${ctx.dataset.unitLabel}` : ''}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: { color: c.faint, maxTicksLimit: 7, maxRotation: 0, font: { size: 10.5 }, callback(v) { return fmtAxisTime(v, S.lastHistorySpan || 600e3); } },
          grid: { color: c.line, drawBorder: false },
        },
        y: {
          ticks: { color: c.faint, font: { size: 10.5 } },
          grid: { color: c.line, drawBorder: false },
          border: { display: false },
        },
      },
    };
  }

  function seriesDs(phase, colorKey, label, unitFmt, opts = {}) {
    const c = chartPalette();
    const color = c[colorKey] || c.accent;
    return {
      label, unitFmt,
      data: [],
      borderColor: color,
      backgroundColor: opts.fill ? hexToRgba(color, opts.fillAlpha ?? 0.1) : color,
      borderWidth: opts.dashed ? 1.5 : 2,
      borderDash: opts.dashed ? [6, 4] : undefined,
      pointRadius: 0, pointHitRadius: 8, pointHoverRadius: 3,
      fill: opts.fill ? 'origin' : false,
      tension: 0.35, cubicInterpolationMode: 'monotone',
      stack: opts.stack, spanGaps: true,
      phaseMeta: phase,
    };
  }

  function pick(p, phase, key) {
    if (key === 'freq') return p.freq;
    return phase === 'total' ? p.tot[key] : p[phase][key];
  }

  function makeChart(id, series, extraOptions = {}) {
    const el = $(id);
    if (!el) return null;
    const opts = baseChartOptions();
    Object.assign(opts.scales, extraOptions.scales || {});
    Object.assign(opts.plugins, extraOptions.plugins || {});
    opts.animation = { duration: extraOptions.noAnim ? 0 : 350 };
    const chart = new Chart(el, { type: extraOptions.type || 'line', data: { datasets: series.map(s => ({ ...s })) }, options: opts, plugins: [chartCursor] });
    const spec = { chart, series: series.map(s => ({ phase: s.phaseMeta, colorKey: s.colorKey, fill: !!s.fill })) };
    S.chartSpecs.push(spec);
    return chart;
  }

  function updateChart(chart, series, points) {
    series.forEach((s, i) => {
      const ds = chart.data.datasets[i];
      ds.data = points.map(p => ({ x: p.t, y: pick(p, s.phase, s.key) }));
      ds.pointRadius = points.length === 1 ? 3 : 0;
    });
    chart.update('none');
  }

  function applyTheme() {
    const c = chartPalette();
    for (const { chart, series } of S.chartSpecs) {
      chart.data.datasets.forEach((ds, i) => {
        const s = series[i];
        const color = c[s.colorKey] || c.accent;
        ds.borderColor = color;
        if (s.fill) ds.backgroundColor = hexToRgba(color, 0.1);
      });
      const o = chart.options;
      o.plugins.tooltip.backgroundColor = c.panel;
      o.plugins.tooltip.titleColor = c.ink;
      o.plugins.tooltip.bodyColor = c.muted;
      o.plugins.tooltip.borderColor = c.line;
      for (const axis of ['x', 'y']) {
        if (!o.scales[axis]) continue;
        o.scales[axis].ticks.color = c.faint;
        o.scales[axis].grid.color = c.line;
        if (o.scales[axis].title) o.scales[axis].title.color = c.faint;
      }
      chart.update('none');
    }
    // donut + sparklines are registered separately
    if (donut) {
      donut.data.datasets[0].backgroundColor = [c.p1, c.p2, c.p3];
      donut.options.plugins.tooltip.backgroundColor = c.panel;
      donut.options.plugins.tooltip.titleColor = c.ink;
      donut.options.plugins.tooltip.bodyColor = c.muted;
      donut.options.plugins.tooltip.borderColor = c.line;
      donut.update('none');
    }
    for (const { chart, spec } of sparkCharts.values()) {
      const color = cssVar(spec.colorKey);
      chart.data.datasets[0].borderColor = color;
      chart.data.datasets[0].backgroundColor = hexToRgba(color, 0.12);
      chart.update('none');
    }
  }

  // ---------------------------------------------------------------- notice

  function showNotice(text, kind = 'error') {
    $('noticeText').textContent = text;
    const n = $('notice');
    n.hidden = false;
    n.style.setProperty('--amber', kind === 'error' ? cssVar('--red') : cssVar('--amber'));
    clearTimeout(S.noticeTimer);
  }
  function hideNotice() { $('notice').hidden = true; }

  // ---------------------------------------------------------------- KPI cards

  const sparkSpecs = [
    { id: 'sparkPower', ring: 'power', colorKey: '--accent' },
    { id: 'sparkEnergy', ring: 'energy', colorKey: '--accent' },
    { id: 'sparkPf', ring: 'pf', colorKey: '--p2' },
    { id: 'sparkFreq', ring: 'freq', colorKey: '--p3' },
    { id: 'sparkCurrent', ring: 'current', colorKey: '--p1' },
    { id: 'sparkImbalance', ring: 'imbalance', colorKey: '--p3' },
  ];
  const sparkCharts = new Map();

  function buildSparks() {
    for (const s of sparkSpecs) {
      const el = $(s.id);
      const color = cssVar(s.colorKey);
      const chart = new Chart(el, {
        type: 'line',
        data: { datasets: [{ data: [], borderColor: color, backgroundColor: hexToRgba(color, 0.12), borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, events: [],
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
      sparkCharts.set(s.ring, { chart, spec: s });
    }
  }

  function deltaSince(ring, ms) {
    const now = Date.now();
    const base = ring.find(e => e.t >= now - ms);
    if (!base || base === ring[ring.length - 1]) return null;
    return ring[ring.length - 1].v - base.v;
  }
  function setDelta(id, delta, unit) {
    const el = $(id);
    if (delta === null || !finite(delta)) { el.textContent = ''; el.className = 'kpi-delta'; return; }
    const up = delta > 0.0001;
    el.textContent = `${up ? '▲' : delta < -0.0001 ? '▼' : '•'} ${up ? '+' : ''}${unit(delta)} vs 1 min ago`;
    el.className = `kpi-delta ${up ? 'up' : delta < -0.0001 ? 'down' : ''}`;
  }

  function pushRing(ring, v) {
    S.rings[ring].push({ t: Date.now(), v });
    if (S.rings[ring].length > 180) S.rings[ring].shift();
  }

  function updateKpis(s) {
    const tot = s.tot;
    pushRing('power', tot.p); pushRing('energy', tot.e_wh); pushRing('pf', tot.pf);
    pushRing('freq', s.freq); pushRing('current', tot.i); pushRing('imbalance', tot.imbalance_p);

    $('kpiPower').textContent = finite(tot.p) ? fmtKw(tot.p) : '—';
    $('kpiEnergy').textContent = finite(tot.e_wh) ? fmtKwh(tot.e_wh) : '—';
    $('kpiPf').textContent = finite(tot.pf) ? fmt.pf.format(tot.pf) : '—';
    $('kpiFreq').textContent = finite(s.freq) ? fmt.Hz.format(s.freq) : '—';
    $('kpiCurrent').textContent = finite(tot.i) ? fmt.A.format(tot.i) : '—';
    $('kpiImbalance').textContent = finite(tot.imbalance_p) ? fmt.pct.format(tot.imbalance_p) : '—';

    setDelta('kpiPowerDelta', deltaSince(S.rings.power, 60e3), v => `${fmtKw(v)} kW`);
    setDelta('kpiEnergyDelta', deltaSince(S.rings.energy, 60e3), v => `${fmtKwh(v)} kWh`);
    setDelta('kpiPfDelta', deltaSince(S.rings.pf, 60e3), v => `${fmt.pf.format(v)}`);
    setDelta('kpiFreqDelta', deltaSince(S.rings.freq, 60e3), v => `${fmt.Hz.format(v)} Hz`);
    setDelta('kpiCurrentDelta', deltaSince(S.rings.current, 60e3), v => `${fmt.A.format(v)} A`);
    setDelta('kpiImbalanceDelta', deltaSince(S.rings.imbalance, 60e3), v => `${fmt.pct.format(v)} %`);

    for (const [ring, { chart }] of sparkCharts) {
      chart.data.datasets[0].data = S.rings[ring].map(e => e.v);
      chart.update('none');
    }
  }

  // ---------------------------------------------------------------- donut + system panel

  let donut = null;
  const donutCenter = {
    id: 'donutCenter',
    afterDraw(chart, args, opts) {
      const { ctx, chartArea } = chart;
      const cx = (chartArea.left + chartArea.right) / 2;
      const cy = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = cssVar('--muted');
      ctx.font = '600 10.5px Inter, system-ui, sans-serif';
      ctx.fillText('TOTAL', cx, cy - 7);
      ctx.fillStyle = cssVar('--ink');
      ctx.font = '700 16px Inter, system-ui, sans-serif';
      ctx.fillText(chart.$center || '—', cx, cy + 13);
      ctx.restore();
    },
  };

  function buildDonut() {
    donut = new Chart($('energyDonut'), {
      type: 'doughnut',
      data: {
        labels: ['L1', 'L2', 'L3'],
        datasets: [{
          data: [0, 0, 0],
          backgroundColor: [cssVar('--p1'), cssVar('--p2'), cssVar('--p3')],
          borderWidth: 0, hoverOffset: 3,
        }],
      },
      options: {
        maintainAspectRatio: false, animation: { duration: 350 },
        cutout: '70%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: cssVar('--panel'), titleColor: cssVar('--ink'), bodyColor: cssVar('--muted'),
            borderColor: cssVar('--line'), borderWidth: 1, padding: 10, cornerRadius: 8,
            callbacks: { label: ctx => ` ${ctx.label}: ${fmtKwh(ctx.parsed)} kWh (${ctx.dataset.data.reduce((a, b) => a + b, 0) > 0 ? fmt.pct.format(ctx.parsed / ctx.dataset.data.reduce((a, b) => a + b, 0) * 100) : 0}%)` },
          },
        },
      },
      plugins: [donutCenter],
    }, { value: '—' });
  }

  function updateDonut(s) {
    if (!donut) return;
    const e = PHASES.map(ph => s[ph].e_wh);
    donut.data.datasets[0].data = e;
    donut.$center = fmtKwh(s.tot.e_wh);
    donut.data.datasets[0].phaseMeta = 'donut';
    donut.update('none');
    const total = e.reduce((a, b) => a + b, 0);
    PHASES.forEach((ph, i) => {
      $('donutLegend').querySelector(`[data-ph="${ph}"] .val`).textContent = `${fmtKwh(e[i])} kWh · ${fmt.pct.format(total > 0 ? e[i] / total * 100 : 0)}%`;
    });
  }

  function buildDonutLegend() {
    const el = $('donutLegend');
    el.innerHTML = '';
    PHASES.forEach((ph, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.ph = ph;
      const key = document.createElement('span');
      key.className = 'key';
      key.innerHTML = `<i style="background:${cssVar(`--p${i + 1}`)}"></i>${ph.toUpperCase()}`;
      const val = document.createElement('span');
      val.className = 'val mono';
      row.append(key, val);
      el.append(row);
    });
  }

  function updateSystem(s, meta) {
    $('sysSeq').textContent = finite(s.seq) ? `sample #${s.seq}` : '—';
    const rows = [
      ['Frequency', finite(s.freq) ? `${fmt.Hz.format(s.freq)} Hz` : 'Unavailable'],
      ['Active power', finite(s.tot.p) ? `${fmtKw(s.tot.p)} kW` : '—'],
      ['Power factor', finite(s.tot.pf) ? fmt.pf.format(s.tot.pf) : '—'],
      ['Phase imbalance', finite(s.tot.imbalance_p) ? `${fmt.pct.format(s.tot.imbalance_p)} %` : '—'],
      ['Energy', finite(s.tot.e_wh) ? `${fmtKwh(s.tot.e_wh)} kWh` : '—'],
      ['Sample age', '—'],
    ];
    const el = $('sysRows');
    el.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'sys-row';
      row.innerHTML = `<span class="k">${k}</span><span class="sys-value">${v}</span>`;
      el.append(row);
    }
    const age = meta ? Math.max(0, Date.now() - s.t) : null;
    if (age !== null) el.querySelectorAll('.sys-row')[5].querySelector('.sys-value').textContent = `${(age / 1000).toFixed(1)} s`;
  }

  // ---------------------------------------------------------------- stat cards

  function statCard(name, unit, value, meta, barPct = null) {
    const card = document.createElement('article');
    card.className = 'stat-card';
    card.innerHTML = `
      <div class="stat-head"><span class="name">${name}</span><span class="unit">${unit}</span></div>
      <div class="stat-value mono">${value}</div>
      <div class="stat-meta">${meta}</div>
      ${barPct === null ? '' : `<div class="stat-bar"><div class="fill" style="width:${clamp(barPct, 0, 100)}%"></div><div class="marker" style="left:${clamp(barPct, 0, 100)}%"></div></div>`}`;
    return card;
  }

  function updatePowerStats(s) {
    const el = $('powerStats');
    el.innerHTML = '';
    const totD = s.tot;
    const demand = k => PHASES.reduce((a, ph) => a + s[ph][k], 0);
    el.append(
      statCard('Active power', 'kW', fmtKw(totD.p), `demand ${fmtKw(demand('p_d'))} kW · L1 ${fmtKw(s.l1.p)} / L2 ${fmtKw(s.l2.p)} / L3 ${fmtKw(s.l3.p)} kW`),
      statCard('Reactive power', 'kvar', fmtKvar(totD.q), `demand ${fmtKvar(demand('q_d'))} kvar · L1 ${fmtKvar(s.l1.q)} / L2 ${fmtKvar(s.l2.q)} / L3 ${fmtKvar(s.l3.q)} kvar`),
      statCard('Apparent power', 'kVA', fmtKva(totD.s), `demand ${fmtKva(demand('s_d'))} kVA · L1 ${fmtKva(s.l1.s)} / L2 ${fmtKva(s.l2.s)} / L3 ${fmtKva(s.l3.s)} kVA`),
    );
  }

  function updateVoltageStats(s) {
    const el = $('voltageStats');
    el.innerHTML = '';
    PHASES.forEach(ph => {
      const d = s[ph];
      const range = d.vln_max - d.vln_min;
      const pct = range > 0 ? (d.vln - d.vln_min) / range * 100 : 50;
      el.append(statCard(`${ph.toUpperCase()} · phase to neutral`, 'V', fmt.V.format(d.vln),
        `60 s range ${fmt.V.format(d.vln_min)}–${fmt.V.format(d.vln_max)} · avg ${fmt.V.format(d.vln_avg)} · L-L ${fmt.V.format(d.vll)}`, pct));
    });
  }

  function updateCurrentStats(s) {
    const el = $('currentStats');
    el.innerHTML = '';
    PHASES.forEach(ph => {
      const d = s[ph];
      el.append(statCard(`${ph.toUpperCase()} · line current`, 'A', fmt.A.format(d.i),
        `demand ${fmt.A.format(d.i_d)} A · P ${fmtKw(d.p)} kW · PF ${fmt.pf.format(d.pf)}`));
    });
  }

  function updateEnergyStats(points) {
    const el = $('energyStats');
    el.innerHTML = '';
    const now = Date.now();
    const d = (ms) => {
      if (!points || points.length < 2) return null;
      const first = points.find(p => p.t >= now - ms);
      if (!first) return null;
      const last = points[points.length - 1];
      return last.tot.e_wh - first.tot.e_wh;
    };
    const h1 = d(3600e3), h24 = d(24 * 3600e3);
    el.append(
      statCard('Energy since start', 'kWh', S.latest ? fmtKwh(S.latest.tot.e_wh) : '—', 'accumulated across all three phases'),
      statCard('Last hour', 'kWh', h1 === null ? '—' : fmtKwh(h1), h1 === null ? 'needs ≥ 1 h of history' : 'Δ from the last 60 minutes'),
      statCard('Last 24 hours', 'kWh', h24 === null ? '—' : fmtKwh(h24), h24 === null ? 'needs ≥ 24 h of history' : 'Δ from the last day'),
    );
  }

  // ---------------------------------------------------------------- live table

  const TABLE_GROUPS = [
    ['voltage_ln', 'Phase to neutral voltage', 'V', ph => ph.vln],
    ['voltage_ln_min', 'Minimum phase to neutral voltage', 'V', ph => ph.vln_min],
    ['voltage_ln_max', 'Maximum phase to neutral voltage', 'V', ph => ph.vln_max],
    ['voltage_ln_avg', 'Average phase to neutral voltage', 'V', ph => ph.vln_avg],
    ['voltage_ll', 'Phase to phase voltage', 'V', ph => ph.vll],
    ['voltage_ll_min', 'Minimum phase to phase voltage', 'V', ph => ph.vll_min],
    ['voltage_ll_max', 'Maximum phase to phase voltage', 'V', ph => ph.vll_max],
    ['voltage_ll_avg', 'Average phase to phase voltage', 'V', ph => ph.vll_avg],
    ['current', 'Current', 'A', ph => ph.i],
    ['current_demand', 'Current demand', 'A', ph => ph.i_d],
    ['active_power', 'Active power', 'W', ph => ph.p],
    ['active_power_demand', 'Active power demand', 'W', ph => ph.p_d],
    ['reactive_power', 'Reactive power', 'var', ph => ph.q],
    ['reactive_power_demand', 'Reactive power demand', 'var', ph => ph.q_d],
    ['apparent_power', 'Apparent power', 'VA', ph => ph.s],
    ['apparent_power_demand', 'Apparent power demand', 'VA', ph => ph.s_d],
    ['power_factor', 'Power factor', '—', ph => ph.pf],
    ['cos_phi', 'Cosine phi', '—', ph => ph.cphi],
    ['frequency', 'Frequency', 'Hz', ph => null],
  ];
  const tableCells = new Map();

  function buildTable() {
    const body = $('liveTableBody');
    for (const [key, label, unit] of TABLE_GROUPS) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${label}</td>${[0, 1, 2].map(() => '<td class="ph num mono">—</td>').join('')}<td class="mono" style="color:var(--muted)">${unit}</td>`;
      if (key === 'frequency') tr.classList.add('freq-row');
      body.append(tr);
      tableCells.set(key, { tr, cells: [...tr.querySelectorAll('td.ph')] });
    }
  }

  function updateTable(s) {
    for (const [key, label, unit, get] of TABLE_GROUPS) {
      const { tr, cells } = tableCells.get(key);
      if (key === 'frequency') {
        PHASES.forEach((ph, i) => {
          cells[i].textContent = finite(s[ph].freq) ? fmt.Hz.format(s[ph].freq) : '—';
        });
        continue;
      }
      PHASES.forEach((ph, i) => {
        const v = get(s[ph]);
        cells[i].textContent = finite(v) ? (unit === 'W' || unit === 'var' || unit === 'VA' ? fmt.W.format(v)
          : unit === 'V' ? fmt.V.format(v) : unit === 'A' ? fmt.A.format(v) : fmt.pf.format(v)) : '—';
      });
    }
    $('tableStamp').textContent = `#${s.seq} · ${fmtClock(s.t)}`;
  }

  // ---------------------------------------------------------------- balance (quality view)

  function updateBalance(s) {
    const el = $('balanceRows');
    el.innerHTML = '';
    const pDSum = PHASES.reduce((a, ph) => a + (finite(s[ph].p_d) ? s[ph].p_d : 0), 0);
    const loadMeaningful = finite(s.tot.p) && s.tot.p > 1e-6 && (pDSum <= 0 || s.tot.p >= pDSum * 0.01);
    if (!loadMeaningful) {
      const empty = document.createElement('p');
      empty.className = 'detail-note';
      empty.textContent = 'No measurable load — live phase powers are near zero relative to demand (or inputs are not connected yet).';
      el.append(empty);
      return;
    }
    const total = s.tot.p;
    const colors = { l1: cssVar('--p1'), l2: cssVar('--p2'), l3: cssVar('--p3') };
    const segs = PHASES.map(ph => {
      const p = s[ph].p;
      return { ph, p, share: total > 0 ? p / total * 100 : 0, color: colors[ph] };
    });
    const bar = document.createElement('div');
    bar.className = 'balance-bar';
    segs.forEach(seg => {
      const i = document.createElement('i');
      i.style.width = `${seg.share}%`;
      i.style.background = seg.color;
      bar.append(i);
    });
    el.append(bar);
    for (const seg of segs) {
      const row = document.createElement('div');
      row.className = 'balance-row';
      row.innerHTML = `<div class="top"><b style="color:${seg.color}">${seg.ph.toUpperCase()}</b><span class="mono">${fmtKw(seg.p)} kW · ${fmt.pct.format(seg.share)}%</span></div>`;
      el.append(row);
    }
  }

  // ---------------------------------------------------------------- history + charts

  const chartDefs = {
    overviewPowerChart: [
      { phase: 'l1', key: 'p', colorKey: '--p1', label: 'L1', fill: true, stack: 'ph' },
      { phase: 'l2', key: 'p', colorKey: '--p2', label: 'L2', fill: true, stack: 'ph' },
      { phase: 'l3', key: 'p', colorKey: '--p3', label: 'L3', fill: true, stack: 'ph' },
      { phase: 'total', key: 'p', colorKey: '--muted', label: 'Total', dashed: true, stack: 'tot' },
    ],
    powerPChart: [
      { phase: 'l1', key: 'p', colorKey: '--p1', label: 'L1', fill: true, stack: 'ph' },
      { phase: 'l2', key: 'p', colorKey: '--p2', label: 'L2', fill: true, stack: 'ph' },
      { phase: 'l3', key: 'p', colorKey: '--p3', label: 'L3', fill: true, stack: 'ph' },
      { phase: 'total', key: 'p', colorKey: '--muted', label: 'Total', dashed: true, stack: 'tot' },
    ],
    powerQChart: [
      { phase: 'l1', key: 'q', colorKey: '--p1', label: 'L1 · var' }, { phase: 'l2', key: 'q', colorKey: '--p2', label: 'L2 · var' },
      { phase: 'l3', key: 'q', colorKey: '--p3', label: 'L3 · var' }, { phase: 'total', key: 'q', colorKey: '--muted', label: 'Total', dashed: true },
    ],
    powerSChart: [
      { phase: 'l1', key: 's', colorKey: '--p1', label: 'L1 · VA' }, { phase: 'l2', key: 's', colorKey: '--p2', label: 'L2 · VA' },
      { phase: 'l3', key: 's', colorKey: '--p3', label: 'L3 · VA' }, { phase: 'total', key: 's', colorKey: '--muted', label: 'Total', dashed: true },
    ],
    powerDChart: [
      { phase: 'l1', key: 'p_d', colorKey: '--p1', label: 'L1' }, { phase: 'l2', key: 'p_d', colorKey: '--p2', label: 'L2' },
      { phase: 'l3', key: 'p_d', colorKey: '--p3', label: 'L3' }, { phase: 'total', key: 'p', colorKey: '--muted', label: 'Total now', dashed: true },
    ],
    voltageLnChart: [
      { phase: 'l1', key: 'vln', colorKey: '--p1', label: 'L1 · V' }, { phase: 'l2', key: 'vln', colorKey: '--p2', label: 'L2 · V' },
      { phase: 'l3', key: 'vln', colorKey: '--p3', label: 'L3 · V' },
    ],
    voltageLlChart: [
      { phase: 'l1', key: 'vll', colorKey: '--p1', label: 'L1-L2 · V' }, { phase: 'l2', key: 'vll', colorKey: '--p2', label: 'L2-L3 · V' },
      { phase: 'l3', key: 'vll', colorKey: '--p3', label: 'L3-L1 · V' },
    ],
    currentChart: [
      { phase: 'l1', key: 'i', colorKey: '--p1', label: 'L1 · A' }, { phase: 'l2', key: 'i', colorKey: '--p2', label: 'L2 · A' },
      { phase: 'l3', key: 'i', colorKey: '--p3', label: 'L3 · A' }, { phase: 'total', key: 'i', colorKey: '--muted', label: 'Total', dashed: true },
    ],
    currentDChart: [
      { phase: 'l1', key: 'i_d', colorKey: '--p1', label: 'L1' }, { phase: 'l2', key: 'i_d', colorKey: '--p2', label: 'L2' },
      { phase: 'l3', key: 'i_d', colorKey: '--p3', label: 'L3' },
    ],
    pfChart: [
      { phase: 'l1', key: 'pf', colorKey: '--p1', label: 'L1' }, { phase: 'l2', key: 'pf', colorKey: '--p2', label: 'L2' },
      { phase: 'l3', key: 'pf', colorKey: '--p3', label: 'L3' }, { phase: 'total', key: 'pf', colorKey: '--muted', label: 'Avg', dashed: true },
    ],
    freqChart: [{ phase: 'total', key: 'freq', colorKey: '--accent', label: 'Frequency · Hz', fill: true }],
  };
  const charts = new Map();
  const CHART_VIEWS = {
    overview: ['overviewPowerChart'],
    power: ['powerPChart', 'powerQChart', 'powerSChart', 'powerDChart'],
    voltage: ['voltageLnChart', 'voltageLlChart'],
    current: ['currentChart', 'currentDChart'],
    quality: ['pfChart', 'freqChart'],
    energy: ['energyBarChart'],
  };

  function createChartFor(id) {
    if (id === 'energyBarChart') {
      const c = chartPalette();
      const bar = new Chart($('energyBarChart'), {
        type: 'bar', plugins: [chartCursor],
        data: {
          datasets: PHASES.map((ph, i) => ({
            label: ph.toUpperCase(),
            data: [],
            backgroundColor: cssVar(`--p${i + 1}`),
            borderRadius: 2,
            stack: 'e',
            phaseMeta: ph,
          })),
        },
        options: {
          maintainAspectRatio: false, animation: { duration: 350 },
          interaction: { mode: 'index', axis: 'x', intersect: false },
          events: CURSOR_EVENTS,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: c.panel, titleColor: c.ink, bodyColor: c.muted,
              borderColor: c.line, borderWidth: 1, padding: 10, cornerRadius: 8,
              callbacks: {
                title: items => items.length && items[0].raw ? fmtTooltipTime(items[0].raw.x) : '',
                label: ctx => ` ${ctx.dataset.label}: ${(nf(3, 3)).format(ctx.parsed.y)} kWh`,
              },
            },
          },
          scales: {
            x: {
              type: 'linear', offset: true,
              ticks: { color: c.faint, maxTicksLimit: 10, maxRotation: 0, font: { size: 10.5 }, callback(v) { return fmtAxisTime(v, S.lastHistorySpan || 600e3); } },
              grid: { display: false },
            },
            y: { beginAtZero: true, ticks: { color: c.faint, font: { size: 10.5 } }, grid: { color: c.line }, border: { display: false } },
          },
        },
      });
      charts.set('energyBarChart', bar);
      bar.options.scales.y.title = { display: true, text: 'kWh', color: cssVar('--faint'), font: { size: 10.5 } };
      S.chartSpecs.push({ chart: bar, series: PHASES.map(ph => ({ phase: ph, colorKey: `--p${PHASES.indexOf(ph) + 1}`, fill: false })) });
      return bar;
    }
    const series = chartDefs[id];
    const ds = series.map(s => {
      const ds = seriesDs(s.phase, s.colorKey, s.label, null, s);
      ds.colorKey = s.colorKey;
      return ds;
    });
    // assign unit formatters + y-axis titles per chart (axis shows raw units)
    const unitLabel = id.startsWith('voltage') ? 'V' : id.startsWith('current') ? 'A'
      : id.includes('QChart') ? 'var' : id.includes('SChart') ? 'VA'
      : id.startsWith('freq') ? 'Hz' : id.startsWith('pf') ? '' : 'W';
    const unit = unitLabel === 'V' ? fmt.V : unitLabel === 'A' ? fmt.A
      : unitLabel === 'Hz' ? fmt.Hz : unitLabel === '' ? fmt.pf : fmt.W;
    ds.forEach(d => { d.unitFmt = unit; d.unitLabel = unitLabel; });
    const chart = makeChart(id, ds);
    if (chart && unitLabel) {
      chart.options.scales.y.title = { display: true, text: unitLabel, color: cssVar('--faint'), font: { size: 10.5 } };
    }
    charts.set(id, chart);
    return chart;
  }

  // Charts are created lazily on first view activation: Chart.js cannot size
  // a canvas that was display:none at creation time (its resize observer never
  // re-attaches), so we never create charts while their view is hidden.
  function ensureChartsFor(view) {
    for (const id of CHART_VIEWS[view] || []) {
      if (!charts.has(id)) createChartFor(id);
    }
  }

  function buildCharts() {
    ensureChartsFor('overview');
  }

  function energyBucketSpec(range) {
    const span = RANGE_SPANS[range] || RANGE_SPANS.live;
    if (span > 180 * 86400e3) return { unit: 'month', note: 'calendar-month buckets · UTC' };
    if (span > 90 * 86400e3) return { unit: 'week', sizeMs: 7 * 86400e3, note: '7-day buckets · UTC' };
    if (span > 86400e3) return { unit: 'day', sizeMs: 86400e3, note: 'daily buckets · UTC' };
    if (span > 3600e3) return { unit: 'hour', sizeMs: 3600e3, note: 'hourly buckets' };
    return { unit: 'minute', sizeMs: 60e3, note: '60 s buckets' };
  }

  function energyBuckets(points, range) {
    if (!points || points.length < 2) return [];
    const spec = energyBucketSpec(range);
    const buckets = [];
    let cur = null;
    for (let i = 1; i < points.length; i++) {
      const p = points[i], prev = points[i - 1];
      const date = new Date(p.t);
      const t0 = spec.unit === 'month' ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
        : Math.floor(p.t / spec.sizeMs) * spec.sizeMs;
      const t1 = spec.unit === 'month' ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) : t0 + spec.sizeMs;
      if (!cur || cur.t0 !== t0) {
        if (cur) buckets.push(cur);
        cur = { t0, t1, e: { l1: 0, l2: 0, l3: 0 } };
      }
      for (const ph of PHASES) {
        const value = p[ph].e_wh, previous = prev[ph].e_wh;
        // Unknown counters and a reset are not negative consumption.
        if (finite(value) && finite(previous) && value >= previous) cur.e[ph] += value - previous;
      }
    }
    if (cur) buckets.push(cur);
    return buckets;
  }

  function setChartWindow(chart) {
    if (!S.historyWindow) return;
    chart.options.scales.x.min = S.historyWindow.from;
    chart.options.scales.x.max = S.historyWindow.to;
  }

  function updateCharts(points) {
    for (const [id, chart] of charts) {
      if (id === 'energyBarChart' || !chart) continue;
      const series = chartDefs[id];
      setChartWindow(chart);
      updateChart(chart, series, points);
    }
    const bar = charts.get('energyBarChart');
    if (!bar) return;
    const buckets = energyBuckets(points, S.range);
    PHASES.forEach((ph, i) => {
      bar.data.datasets[i].data = buckets.map(b => ({ x: b.t0, y: b.e[ph] / 1000 }));
    });
    setChartWindow(bar);
    bar.update('none');
    const bucketSpec = energyBucketSpec(S.range);
    $('energyChartTitle').textContent = `Energy per ${bucketSpec.unit}`;
    $('energyChartSub').textContent = `kWh · ${bucketSpec.note}`;
    updateEnergyStats(points);
  }

  async function fetchHistory(force = false) {
    if (!CHART_VIEWS[S.view] || (S.paused && !force) || (S.historyPending && !force)) return;
    const range = S.range, span = RANGE_SPANS[range] || RANGE_SPANS.live;
    const interval = span > 86400e3 ? 60000 : span > 3600e3 ? 15000 : S.pollMs;
    if (!force && Date.now() - S.lastHistoryFetch < interval) return;
    const request = ++S.historyRequest;
    S.historyPending = true;
    S.lastHistoryFetch = Date.now();
    const label = $('rangeSelect').selectedOptions?.[0]?.textContent || range;
    $('historySummary').textContent = `Loading ${label} history…`;
    $('historyStatus').dataset.state = 'loading';
    try {
      const res = await fetch(`/api/history?range=${encodeURIComponent(range)}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (request !== S.historyRequest || range !== S.range) return;
      if (!Array.isArray(data.points) || data.points.length > 720
          || (data.range !== undefined && data.range !== range)
          || data.points.some((p, i) => !p || !finite(p.t) || !p.l1 || !p.l2 || !p.l3 || !p.tot
            || (i > 0 && p.t < data.points[i - 1].t))) throw new Error('invalid history response');
      const to = finite(data.to) ? data.to : Date.now();
      const from = finite(data.from) ? data.from : to - span;
      if (to <= from || data.points.some(p => p.t < from || p.t > to)) throw new Error('invalid history window');
      S.lastHistory = data.points;
      S.lastHistorySpan = to - from;
      S.historyWindow = { from, to };
      updateCharts(data.points);
      const count = data.points.length;
      const coverage = count ? `${count} points · recorded ${fmtTooltipTime(data.points[0].t)} – ${fmtTooltipTime(data.points[count - 1].t)}`
        : 'No recorded data in this time range. History appears as measurements are collected.';
      $('historySummary').textContent = `${label} · ${coverage}${data.warning ? ` · ${data.warning}` : ''}`;
      $('historyStatus').dataset.state = data.partial ? 'partial' : 'ready';
    } catch (error) {
      if (request === S.historyRequest && range === S.range) {
        $('historySummary').textContent = `Unable to load ${label} history (${error.message || 'network error'}). Last chart data retained; retrying.`;
        $('historyStatus').dataset.state = 'error';
      }
    } finally {
      if (request === S.historyRequest) S.historyPending = false;
    }
  }

  // ---------------------------------------------------------------- readings poll

  function clearMeasurements() {
    S.latest = null;
    S.lastHistory = [];
    for (const ring of Object.values(S.rings)) ring.length = 0;
    for (const { chart } of sparkCharts.values()) {
      chart.data.datasets[0].data = [];
      chart.update('none');
    }
    updateCharts([]);
    if (donut) {
      donut.data.datasets[0].data = [];
      donut.$center = '—';
      donut.update('none');
    }
    for (const el of document.querySelectorAll('.kpi-value, .kpi-delta, .sys-value, td.ph, .stat-value, .stat-meta, .donut-legend .val')) {
      el.textContent = '—';
    }
    $('balanceRows').textContent = 'No valid meter sample yet.';
    $('sysSeq').textContent = '—';
    $('tableStamp').textContent = 'No valid meter sample yet';
  }

  async function pollReadings() {
    try {
      const res = await fetch('/api/readings', { cache: 'no-store', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.meta || (data.sample !== null && !data.sample?.tot)) throw new Error('invalid readings response');
      const previous = S.latest;
      S.meta = data.meta;
      S.online = true;
      if (!S.paused) hideNotice();
      if (data.sample === null) {
        if (!S.paused) clearMeasurements();
        updateSourcePills(data);
        return;
      }
      if (S.paused) { updateSourcePills(data); return; }
      S.latest = data.sample;
      if (!previous || previous.t !== data.sample.t || previous.seq !== data.sample.seq) updateKpis(data.sample);
      updateDonut(data.sample);
      updateSystem(data.sample, data.meta);
      updateTable(data.sample);
      updatePowerStats(data.sample);
      updateVoltageStats(data.sample);
      updateCurrentStats(data.sample);
      updateBalance(data.sample);
      updateSourcePills(data);
    } catch (err) {
      S.online = false;
      $('sourcePill').textContent = 'Server offline';
      $('sourcePill').className = 'pill bad';
      $('sideDot').className = 'dot bad';
      $('sideSource').textContent = 'Server offline';
      showNotice(`Unable to reach the server API (${err.message || 'network error'}). Last known values remain visible; retrying automatically.`);
    }
  }

  // ---------------------------------------------------------------- serial console

  function serialState(device) {
    return { device, after: 0, entries: [], lastBatch: null, pending: false,
      paused: false, loaded: false, cleared: false, truncated: false,
      hasMore: false, error: '', timer: null };
  }

  function renderSerialLogs() {
    const serial = S.serial, output = $('serialOutput');
    const text = serial.entries.map(batch => batch.text).join('');
    if (output.textContent !== text) {
      const top = output.scrollTop;
      output.textContent = text; // Device output is untrusted; never use innerHTML.
      output.scrollTop = $('serialAutoscroll').checked ? output.scrollHeight : top;
    }
    $('serialEmpty').hidden = serial.entries.length > 0;
    $('serialEmpty').textContent = serial.cleared
      ? 'Display cleared. New batches will appear here; saved logs remain on the server.'
      : serial.pending ? 'Loading stored console logs…'
        : 'No console logs received for this device yet. Waiting for ESP32 log uploads.';
    const pill = $('serialPill');
    pill.textContent = serial.paused ? 'Logs paused' : serial.error ? 'Logs unavailable'
      : serial.pending && !serial.loaded ? 'Loading logs' : serial.hasMore ? 'Loading history'
        : serial.lastBatch ? 'Following logs' : 'Waiting for logs';
    pill.className = `pill ${serial.paused ? 'warn' : serial.error ? 'bad' : serial.lastBatch ? 'good' : ''}`;
    $('serialMessage').hidden = !serial.error;
    $('serialMessage').textContent = serial.error;
    $('serialPause').textContent = serial.paused ? 'Resume logs' : 'Pause logs';
    $('serialPause').setAttribute('aria-pressed', String(serial.paused));
    $('serialRefresh').textContent = serial.pending ? 'Reading…' : 'Refresh';
    $('serialRefresh').disabled = serial.pending;
    $('serialClear').disabled = serial.pending || !serial.entries.length;
    $('serialLoad').disabled = serial.pending;
    const last = serial.lastBatch;
    $('serialMeta').textContent = last
      ? `${last.device_name} · firmware v${last.firmware_version} · boot ${last.boot_id} · sequence ${last.sequence} · reported dropped bytes: ${last.dropped_bytes} · received ${new Date(last.received_at).toLocaleString()}`
      : 'No log batch received yet.';
    $('serialSummary').textContent = `${serial.entries.length} batches shown${serial.truncated ? ' (display limited to the latest 200 loaded batches)' : ''} · refresh ${S.pollMs / 1000}s while Settings is open · Clear display does not delete saved logs.`;
  }

  async function pollSerialLogs(force = false) {
    const serial = S.serial;
    if (S.view !== 'settings' || document.hidden || serial.pending || (serial.paused && !force)) return;
    clearTimeout(serial.timer);
    serial.pending = true;
    renderSerialLogs();
    try {
      const query = new URLSearchParams({ after: String(serial.after), limit: '100' });
      if (serial.device) query.set('device', serial.device);
      const response = await fetch(`/api/serial-log?${query}`, {
        cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4500),
      });
      if (!response.ok) throw new Error(response.status === 403
        ? 'Serial logs are private. Open this dashboard using the Jetson’s Tailscale address.'
        : `Unable to load serial logs (HTTP ${response.status}). Retrying automatically.`);
      const data = await response.json();
      if (serial !== S.serial || (serial.paused && !force)) return;
      let cursor = serial.after;
      if (!data || !Array.isArray(data.batches) || data.batches.length > 200
          || !Number.isSafeInteger(data.next_after) || data.next_after < cursor || typeof data.has_more !== 'boolean') {
        throw new Error('The serial-log API returned an invalid response. Last displayed logs are retained.');
      }
      for (const batch of data.batches) {
        if (!batch || !Number.isSafeInteger(batch.id) || batch.id <= cursor
            || typeof batch.text !== 'string' || batch.text.length > 4096) {
          throw new Error('The serial-log API returned an invalid batch. Last displayed logs are retained.');
        }
        cursor = batch.id;
      }
      if (data.next_after !== cursor || (data.has_more && cursor === serial.after)) {
        throw new Error('The serial-log API returned an invalid cursor. Last displayed logs are retained.');
      }
      serial.entries.push(...data.batches);
      if (data.batches.length) {
        serial.lastBatch = data.batches[data.batches.length - 1];
        serial.cleared = false;
      }
      if (serial.entries.length > 200) {
        serial.entries = serial.entries.slice(-200);
        serial.truncated = true;
      }
      serial.after = cursor;
      serial.hasMore = data.has_more;
      serial.loaded = true;
      serial.error = '';
    } catch (error) {
      if (serial === S.serial) serial.error = error.message || 'Unable to load serial logs. Retrying automatically.';
    } finally {
      serial.pending = false;
      if (serial === S.serial) {
        renderSerialLogs();
        if (serial.hasMore && !serial.paused && !serial.error) {
          serial.timer = setTimeout(() => pollSerialLogs(), 100);
        }
      }
    }
  }

  function resetSerialLogs(device) {
    if (device && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(device)) {
      S.serial.error = 'Enter a valid device name: letters, digits, dots, underscores or hyphens.';
      renderSerialLogs();
      return;
    }
    clearTimeout(S.serial.timer);
    S.serial = serialState(device);
    renderSerialLogs();
    return pollSerialLogs();
  }

  function bindSerialControls() {
    $('serialDeviceForm').addEventListener('submit', event => {
      event.preventDefault();
      return resetSerialLogs($('serialDevice').value.trim());
    });
    $('serialPause').addEventListener('click', () => {
      S.serial.paused = !S.serial.paused;
      clearTimeout(S.serial.timer);
      renderSerialLogs();
      if (!S.serial.paused) return pollSerialLogs();
    });
    $('serialRefresh').addEventListener('click', () => pollSerialLogs(true));
    $('serialClear').addEventListener('click', () => {
      S.serial.entries = [];
      S.serial.cleared = true;
      S.serial.truncated = false;
      renderSerialLogs();
    });
    $('serialAutoscroll').addEventListener('change', () => {
      if ($('serialAutoscroll').checked) $('serialOutput').scrollTop = $('serialOutput').scrollHeight;
    });
    renderSerialLogs();
  }

  // ---------------------------------------------------------------- OTA panel

  const cmpVersions = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (pa[i] > pb[i]) return 1;
      if (pa[i] < pb[i]) return -1;
    }
    return 0;
  };

  function otaMsg(text, tone = '') {
    const el = $('otaMsg');
    el.hidden = !text;
    el.textContent = text || '';
    el.style.color = tone === 'ok' ? cssVar('--accent') : tone === 'err' ? cssVar('--red') : cssVar('--muted');
  }

  function updateOtaPanel(ota) {
    if (!ota) return;
    const pill = $('otaPill');
    if (ota.enabled && ota.active_version) { pill.textContent = `feed on · ${ota.active_version}`; pill.className = 'pill good'; }
    else if (ota.staged) { pill.textContent = 'staged · feed off'; pill.className = 'pill warn'; }
    else { pill.textContent = 'feed inactive'; pill.className = 'pill'; }

    const ago = ms => (ms == null ? '—' : `${Math.max(0, Math.round((Date.now() - ms) / 1000))} s ago`);
    const rows = [
      ['Active release', ota.active_version || 'none (feed disabled)'],
      ['Active published', ota.active_published_at ? fmtClock(new Date(ota.active_published_at).getTime()) : '—'],
      ['Staged release', ota.staged ? `${ota.staged.version} · ${fmtBytes(ota.staged.size)} · sha256 ${ota.staged.sha256.slice(0, 12)}…` : '—'],
      ['Device reported version', ota.reported_version ? `${ota.reported_version} · ${ago(ota.reported_at)}` : 'not reported yet'],
      ['Firmware downloads', ota.downloads && ota.downloads.count ? `${ota.downloads.count} · last ${ago(ota.downloads.last_at)}` : 'none yet'],
      ['OTA token', ota.token_configured ? 'configured (server-only)' : 'NOT configured — ESP32 pulls are rejected'],
    ];
    const el = $('otaRows');
    el.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.innerHTML = `<span class="k">${k}</span><span class="v mono">${v}</span>`;
      el.append(row);
    }

    // completion status: active release vs device-reported version vs downloads
    const note = $('otaNote');
    note.style.color = '';
    if (ota.active_version && ota.reported_version === ota.active_version) {
      note.textContent = `✓ Device confirmed on ${ota.reported_version} — update complete.`;
      note.style.color = cssVar('--accent');
    } else if (ota.active_version && ota.downloads && ota.downloads.count > 0) {
      note.textContent = `Device downloaded ${ota.active_version} (${ota.downloads.count} fetch${ota.downloads.count === 1 ? '' : 'es'}) — waiting for it to report the new version.`;
    } else if (ota.active_version) {
      note.textContent = `Release ${ota.active_version} active — waiting for the ESP32 to poll the feed.`;
    } else {
      note.textContent = 'Upload stages the firmware; Install Update atomically activates the release feed. The ESP32 picks it up on its next OTA poll and confirms back with its reported version.';
    }

    S.otaStagedVersion = ota.staged ? ota.staged.version : S.otaStagedVersion;
    const installBtn = $('otaInstallBtn');
    if (ota.staged && (!ota.active_version || cmpVersions(ota.staged.version, ota.active_version) > 0)) {
      S.otaStagedVersion = ota.staged.version;
      installBtn.disabled = false;
    } else if (!ota.staged) {
      S.otaStagedVersion = null;
      installBtn.disabled = true;
    } else {
      installBtn.disabled = true; // staged but not newer than active
    }
  }

  function updateSourcePills(data) {
    const source = data && data.source;
    const meta = data && data.meta;
    const dev = meta && meta.device && typeof meta.device === 'object' ? meta.device : null;
    const sim = meta && meta.sim;
    const mode = meta ? meta.source_mode : null;
    const pill = $('sourcePill');
    const dot = $('sideDot');
    let pillText, pillCls, dotCls, sideText, bannerMsg = null, bannerKind = 'info';

    if (source === 'device') {
      const health = dev && dev.health;
      const labels = { waiting: 'Waiting for ESP32', esp32_offline: 'ESP32 offline',
        adapter_disconnected: 'RS-485 disconnected', meter_error: 'Meter error',
        meter_no_data: 'No meter data', meter_stale: 'Meter stale' };
      if (health && health.code !== 'ok') {
        pillText = labels[health.code] || 'Device fault';
        const error = health.severity === 'error';
        pillCls = error ? 'pill bad' : 'pill warn';
        dotCls = error ? 'dot bad' : 'dot warn';
        bannerKind = error ? 'error' : 'info';
        bannerMsg = health.message + (data.sample
          ? ` Showing last known values from ${fmtClock(data.sample.t)}; not live.`
          : ' No valid meter sample yet.');
      } else if (!dev || !dev.connected || dev.stale) {
        pillText = 'Device unavailable'; pillCls = 'pill bad'; dotCls = 'dot bad';
        bannerMsg = 'Device readings unavailable. Displayed values are not live.';
        bannerKind = 'error';
      } else {
        pillText = S.paused ? 'Display paused' : 'Device live';
        pillCls = S.paused ? 'pill warn' : 'pill good';
        dotCls = S.paused ? 'dot warn' : 'dot ok pulse';
      }
      sideText = pillText;
      if (data.sample) {
        const reversed = PHASES.filter(ph =>
          finite(data.sample[ph].pf) && data.sample[ph].pf < -0.5);
        if (reversed.length) {
          bannerMsg = (bannerMsg ? bannerMsg + ' ' : '') +
            `${reversed.map(p => p.toUpperCase()).join('/')} report reverse power flow ` +
            '(negative power factor) — check CT orientation or export direction.';
        }
      }
    } else {
      if (sim && sim.running) {
        pillText = 'Simulation'; pillCls = 'pill warn'; dotCls = 'dot ok pulse';
        sideText = mode === 'auto' ? 'Simulator · auto (waiting for ESP32)' : 'Simulator running';
      } else {
        pillText = 'Paused'; pillCls = 'pill'; dotCls = 'dot warn';
        sideText = 'Simulator paused';
      }
      if (mode === 'auto' && dev && dev.health && dev.health.code !== 'ok') {
        bannerMsg = `${dev.health.message} Showing SIMULATED data, not meter measurements.`;
      }
    }
    if (!S.online) { dotCls = 'dot bad'; }

    pill.textContent = pillText; pill.className = pillCls;
    dot.className = dotCls;
    $('sideSource').textContent = sideText;
    if (bannerMsg) { showNotice(bannerMsg, bannerKind); S.deviceBanner = true; }
    else if (!S.paused) { hideNotice(); S.deviceBanner = false; }
    if (S.paused && !(dev && dev.stale) && !bannerMsg) showNotice('Display paused. Connection monitoring remains active.', 'info');
    $('sideMeta').textContent = meta
      ? `seq #${S.latest ? S.latest.seq : '—'} · ${meta.buffers.sec} s + ${meta.buffers.min} min buffered`
      : '—';
    if (meta) {
      $('footerInfo').textContent = `Server uptime ${fmtUptime(Date.now() - meta.started_at)} · poll ${S.pollMs / 1000}s · ${meta.buffers.sec} one-second + ${meta.buffers.min} one-minute samples`;
      const modeSel = $('sourceMode');
      if (modeSel && mode && modeSel.value !== mode) modeSel.value = mode;
      if (meta.esp32_url) $('esp32UrlNote').textContent = meta.esp32_url;
      // database panel
      const dbInfo = meta.db;
      if (dbInfo) {
        $('dbPill').textContent = 'active';
        $('dbPill').className = 'pill good';
        $('dbPathNote').textContent = dbInfo.path;
        const rows2 = [
          ['Samples stored', Number(dbInfo.rows).toLocaleString()],
          ['File size', fmtBytes(dbInfo.size_bytes)],
          ['Oldest sample', dbInfo.oldest_t ? fmtClock(dbInfo.oldest_t) : '—'],
          ['Newest sample', dbInfo.newest_t ? fmtClock(dbInfo.newest_t) : '—'],
        ];
        const el2 = $('dbRows');
        el2.innerHTML = '';
        for (const [k, v] of rows2) {
          const row = document.createElement('div');
          row.className = 'setting-row';
          row.innerHTML = `<span class="k">${k}</span><span class="v mono">${v}</span>`;
          el2.append(row);
        }
      } else {
        $('dbPill').textContent = 'unavailable';
        $('dbPill').className = 'pill bad';
      }
      if (meta.ota) updateOtaPanel(meta.ota);
    }
    const agoS = ms => (ms == null ? '—' : `${Math.max(0, Math.round((Date.now() - ms) / 1000))} s ago`);
    const fw = meta && meta.ota ? meta.ota.reported_version : null;
    const fwEl = $('sideFirmware');
    fwEl.textContent = fw ? `ESP32 firmware: v${fw}` : 'ESP32 firmware: Not reported';
    fwEl.hidden = false;
    const rows = [
      ['Source', source === 'device' ? 'ESP32 device' : 'Built-in simulator'],
      ['Device firmware', fw ? `v${fw} · ${agoS(meta.ota.reported_at)}` : 'not reported yet'],
      ['Source mode', mode === 'auto' ? 'Auto' : mode === 'device' ? 'ESP32 only' : 'Simulator only'],
      ['Data flow', dev && dev.feed === 'push' ? 'ESP32 → server (push)' : 'server → ESP32 (pull)'],
      ['Latest sample', S.latest ? `#${S.latest.seq} · ${fmtClock(S.latest.t)}` : '—'],
      ['ESP32 status', !dev ? '—' : dev.connected ? 'connected' : 'unreachable'],
      ['Communication health', dev && dev.health ? dev.health.message : '—'],
      ['Transport error', dev && dev.last_error ? dev.last_error : '—'],
      ['Meter error', dev && dev.meter_error ? dev.meter_error : '—'],
      ['Last valid meter sample', dev && dev.last_sample_at ? `${fmtClock(dev.last_sample_at)} (${agoS(dev.last_sample_at)})` : 'never'],
      ['Meter sample age', dev && dev.sample_age_ms != null ? `${(dev.sample_age_ms / 1000).toFixed(1)} s` : '—'],
      ['ESP32 last seen', dev && dev.last_seen ? `${fmtClock(dev.last_seen)} (${agoS(dev.last_seen)})` : 'never'],
      ['Meter adapter', dev && dev.adapter_connected === true ? `connected · ${dev.baudrate || '?'} baud` : dev && dev.adapter_connected === false ? 'disconnected' : '—'],
      ['Meter device id', dev && dev.device_id != null ? `Device ${dev.device_id}` : '—'],
      ['Meter sequence', dev && dev.sequence != null ? `#${dev.sequence}` : '—'],
      ['Registers', dev && dev.register_count != null ? `${dev.register_count} words @ ${dev.start_address}` : '—'],
      ['Server started', meta ? fmtClock(meta.started_at) : '—'],
      ['History buffers', meta ? `${meta.buffers.sec} s / ${meta.buffers.min} min` : '—'],
      ['Push ingest', 'POST /api/ingest'],
    ];
    const el = $('sourceRows');
    el.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'setting-row';
      const key = document.createElement('span');
      key.className = 'k'; key.textContent = k;
      const value = document.createElement('span');
      value.className = 'v mono'; value.textContent = v;
      row.append(key, value);
      el.append(row);
    }
  }

  // ---------------------------------------------------------------- loop

  async function loop() {
    await pollReadings(); // Keep fault feedback active even when charts are paused.
    pollSerialLogs(); // Independent of the chart pause control; only active in Settings.
    if (!S.paused) await fetchHistory();
    S.timer = setTimeout(loop, S.pollMs);
  }

  // ---------------------------------------------------------------- views & controls

  const VIEW_META = {
    overview: ['Overview', 'Three-phase measurements · TPM-04-100D'],
    power: ['Power', 'Active, reactive and apparent power per phase'],
    voltage: ['Voltage', 'Phase to neutral and phase to phase'],
    current: ['Current', 'Line currents and rolling demand'],
    quality: ['Power quality', 'Power factor, frequency and phase balance'],
    energy: ['Energy', 'Accumulated energy and bucket breakdown'],
    table: ['Live data', 'All measurement groups · updated every poll'],
    settings: ['Settings', 'ESP32 console, firmware, data source and appearance'],
  };

  function showView(name) {
    S.view = name;
    for (const btn of document.querySelectorAll('.nav-item')) {
      btn.classList.toggle('active', btn.dataset.view === name);
    }
    for (const sec of document.querySelectorAll('.view')) {
      sec.classList.toggle('active', sec.dataset.view === name);
    }
    const [title, sub] = VIEW_META[name] || [name, ''];
    $('viewTitle').textContent = title;
    $('viewSubtitle').textContent = sub;
    $('historyStatus').hidden = !CHART_VIEWS[name];
    $('rangeWrap').hidden = !CHART_VIEWS[name];
    // create the view's charts only now that it is visible, then feed them.
    // Synchronous: Chart.js reads the container size itself (forcing layout),
    // and rAF can be throttled to never fire in background tabs.
    ensureChartsFor(name);
    if (S.lastHistory) updateCharts(S.lastHistory);
    if (CHART_VIEWS[name]) fetchHistory(true);
    if (S.latest) updateEnergyStats(S.lastHistory);
    if (name === 'settings') pollSerialLogs();
  }

  function applyPhaseVisibility() {
    for (const { chart } of S.chartSpecs) {
      chart.data.datasets.forEach(d => {
        if (d.phaseMeta && d.phaseMeta in S.phasesOn) d.hidden = !S.phasesOn[d.phaseMeta];
      });
      chart.update('none');
    }
  }

  function bindControls() {
    bindSerialControls();
    for (const btn of document.querySelectorAll('.nav-item')) {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    }
    $('rangeSelect').addEventListener('change', e => {
      if (!Object.hasOwn(RANGE_SPANS, e.target.value)) return;
      S.range = e.target.value;
      fetchHistory(true);
    });
    for (const chip of document.querySelectorAll('.chip')) {
      chip.addEventListener('click', () => {
        const ph = chip.dataset.phase;
        S.phasesOn[ph] = !S.phasesOn[ph];
        chip.classList.toggle('active', S.phasesOn[ph]);
        applyPhaseVisibility();
      });
    }
    $('pauseBtn').addEventListener('click', () => {
      S.paused = !S.paused;
      $('pauseBtn').classList.toggle('active', S.paused);
      $('pauseBtn').setAttribute('aria-pressed', String(S.paused));
      $('pauseBtn').textContent = S.paused ? '▶' : '❚❚';
      if (S.paused) showNotice('Live updates paused. Charts keep their last known values.', 'info');
      else hideNotice();
    });

    // theme
    const apply = (theme) => {
      S.theme = theme;
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('emTheme', theme);
      $('darkToggle').checked = theme === 'dark';
      applyTheme();
      buildDonutLegend();
    };
    $('themeBtn').addEventListener('click', () => apply(S.theme === 'dark' ? 'light' : 'dark'));
    $('darkToggle').addEventListener('change', e => apply(e.target.checked ? 'dark' : 'light'));

    // simulator controls
    const postSim = (body) => fetch('/api/sim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {});
    $('simRunning').addEventListener('change', e => postSim({ running: e.target.checked }));
    let multTimer = null;
    $('simMultiplier').addEventListener('input', e => {
      $('multOut').textContent = `${Number(e.target.value).toFixed(2)}×`;
      clearTimeout(multTimer);
      multTimer = setTimeout(() => postSim({ multiplier: Number(e.target.value) }), 200);
    });
    let noiseTimer = null;
    $('simNoise').addEventListener('input', e => {
      $('noiseOut').textContent = Number(e.target.value).toFixed(1);
      clearTimeout(noiseTimer);
      noiseTimer = setTimeout(() => postSim({ noise: Number(e.target.value) }), 200);
    });
    $('spikeBtn').addEventListener('click', () => postSim({ spike: true }));
    $('sourceMode').addEventListener('change', e => {
      fetch('/api/source', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: e.target.value }),
      }).catch(() => {});
    });
    $('exportBtn').addEventListener('click', () => {
      const range = $('exportRange').value;
      const group = $('exportGroup').value;
      window.location.href = `/api/export?range=${encodeURIComponent(range)}&group=${encodeURIComponent(group)}`;
    });
    // firmware update flow
    $('otaFile').addEventListener('change', () => {
      const f = $('otaFile').files && $('otaFile').files[0];
      $('otaFileName').textContent = f ? `${f.name} (${fmtBytes(f.size)})` : 'no file selected';
      $('otaUploadBtn').disabled = !f;
      if (!f) return;
      if (f.size > 0x3f0000) {
        otaMsg(`✗ ${f.name} is ${fmtBytes(f.size)} — exceeds the 0x3f0000 OTA partition cap.`, 'err');
        $('otaUploadBtn').disabled = true;
      } else {
        otaMsg('');
      }
    });
    $('otaUploadBtn').addEventListener('click', () => {
      const f = $('otaFile').files && $('otaFile').files[0];
      if (!f) return;
      const btn = $('otaUploadBtn');
      btn.disabled = true; btn.textContent = 'Uploading…';
      const prog = $('otaProgress'), fill = $('otaProgressFill');
      prog.hidden = false; fill.style.width = '0%';
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/ota/upload');
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) fill.style.width = `${Math.round(e.loaded / e.total * 100)}%`;
      };
      const finish = (text, tone) => {
        prog.hidden = true;
        btn.disabled = false; btn.textContent = 'Upload & validate';
        otaMsg(text, tone);
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
        if (xhr.status === 200 && data && data.ok) {
          finish(`✓ ${data.project} ${data.version} staged (${fmtBytes(data.size)}, sha256 ${data.sha256.slice(0, 12)}…). Click Install Update to activate.`, 'ok');
        } else {
          finish(`✗ ${(data && data.error) || `upload failed (HTTP ${xhr.status})`}`, 'err');
        }
      };
      xhr.onerror = () => finish('✗ upload failed — network error.', 'err');
      xhr.send(f);
    });
    $('otaInstallBtn').addEventListener('click', () => {
      const version = S.otaStagedVersion;
      if (!version) return;
      if (!window.confirm(`Install and activate firmware ${version}? The ESP32 will download and flash it on its next OTA poll.`)) return;
      const btn = $('otaInstallBtn');
      btn.disabled = true; btn.textContent = 'Installing…';
      fetch('/api/ota/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      }).then(async r => {
        const d = await r.json().catch(() => ({}));
        btn.textContent = 'Install Update';
        if (r.ok && d.ok) {
          otaMsg(`✓ ${d.active_version} activated — waiting for the ESP32 to download it.`, 'ok');
        } else {
          otaMsg(`✗ ${d.error || `install failed (HTTP ${r.status})`}`, 'err');
        }
      }).catch(() => { btn.textContent = 'Install Update'; otaMsg('✗ install failed — network error.', 'err'); });
    });
    $('pollInterval').addEventListener('change', e => {
      S.pollMs = Number(e.target.value) * 1000;
      $('pollOut').textContent = `${e.target.value} s`;
      localStorage.setItem('emPollMs', S.pollMs);
      clearTimeout(S.timer);
      S.timer = setTimeout(loop, S.pollMs);
    });

    // CSV exports
    $('csvEnergy').addEventListener('click', () => {
      const buckets = energyBuckets(S.lastHistory, S.range);
      if (!buckets.length) return;
      const rows = [['Bucket start (local)', 'kWh L1', 'kWh L2', 'kWh L3', 'kWh total'],
        ...buckets.map(b => [new Date(b.t0).toLocaleString(), b.e.l1.toFixed(5), b.e.l2.toFixed(5), b.e.l3.toFixed(5), (b.e.l1 + b.e.l2 + b.e.l3).toFixed(5)])];
      downloadCsv(`energy-${S.range}-${Date.now()}.csv`, rows);
    });
    $('csvPower').addEventListener('click', () => {
      const pts = S.lastHistory || [];
      if (!pts.length) return;
      const rows = [['Time (local)', 'P L1 (W)', 'P L2 (W)', 'P L3 (W)', 'P total (W)', 'Q total (var)', 'S total (VA)', 'PF'],
        ...pts.map(p => [new Date(p.t).toLocaleString(), p.l1.p.toFixed(1), p.l2.p.toFixed(1), p.l3.p.toFixed(1), p.tot.p.toFixed(1), p.tot.q.toFixed(1), p.tot.s.toFixed(1), p.tot.pf.toFixed(3)])];
      downloadCsv(`power-${S.range}-${Date.now()}.csv`, rows);
    });
  }

  function downloadCsv(name, rows) {
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------------------------------------------------------- boot

  function boot() {
    if (typeof Chart === 'undefined') {
      showNotice('Chart.js failed to load — check public/vendor/chart.umd.min.js.');
      return;
    }
    Chart.defaults.font.family = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
    Chart.defaults.color = cssVar('--muted');

    document.documentElement.dataset.theme = S.theme;
    $('darkToggle').checked = S.theme === 'dark';
    $('pollInterval').value = S.pollMs / 1000;
    $('pollOut').textContent = `${S.pollMs / 1000} s`;

    buildSparks();
    buildDonut();
    buildDonutLegend();
    buildCharts();
    buildTable();
    bindControls();
    showView('overview');

    setInterval(() => { $('clock').textContent = fmtClock(Date.now()); }, 1000);
    $('clock').textContent = fmtClock(Date.now());

    loop();
  }

  boot();
})();
