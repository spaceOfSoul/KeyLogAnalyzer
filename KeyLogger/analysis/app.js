(function () {
  const RAW_EVENTS = Array.isArray(window.__EVENTS__) ? window.__EVENTS__ : [];

  const state = {
    rangeStart: 0,
    rangeEnd: 0,
    selectedKeys: new Set(),
    bucketMs: 1000,
    ipsChartType: 'line',
    keyPlotMode: 'raster',
    activeTab: 'ips',
    keyPlotHeights: new Map(),
  };

  const els = {};
  let ipsChart = null;
  const keyCharts = new Map();

  function fmtDateTimeLocal(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function parseDateTimeLocal(v) {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }

  function fmtClock(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function unitLabel(bucketMs) {
    if (bucketMs === 1000) return 'IPS (input/s)';
    if (bucketMs >= 1000) return `input/${bucketMs / 1000}s`;
    return `input/${bucketMs}ms`;
  }

  function getDistinctKeys() {
    const s = new Set();
    for (const e of RAW_EVENTS) s.add(e.k);
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }

  function buildKeyFilterUI(keys, searchTerm) {
    els.keyGrid.innerHTML = '';
    const term = (searchTerm || '').trim().toLowerCase();
    const visibleKeys = term ? keys.filter((k) => k.toLowerCase().includes(term)) : keys;
    for (const k of visibleKeys) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = k;
      cb.checked = state.selectedKeys.has(k);
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedKeys.add(k);
        else state.selectedKeys.delete(k);
        render();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(k));
      els.keyGrid.appendChild(label);
    }
  }

  function getFilteredEvents() {
    return RAW_EVENTS.filter(
      (e) => e.t >= state.rangeStart && e.t <= state.rangeEnd && state.selectedKeys.has(e.k)
    );
  }

  // downEvents: array of {t,k,d}; only d===true counted as a press
  function computeBuckets(downEvents, rangeStart, rangeEnd, bucketMs) {
    const bucketCount = Math.max(1, Math.floor((rangeEnd - rangeStart) / bucketMs) + 1);
    const counts = new Array(bucketCount).fill(0);
    for (const e of downEvents) {
      const idx = Math.floor((e.t - rangeStart) / bucketMs);
      if (idx >= 0 && idx < bucketCount) counts[idx] += 1;
    }
    const times = counts.map((_, i) => rangeStart + i * bucketMs);
    return { times, counts };
  }

  function median(arr) {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function renderStats(counts) {
    if (counts.length === 0) {
      els.statAvg.textContent = els.statMax.textContent = els.statMin.textContent = els.statMed.textContent = '-';
      return;
    }
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    els.statAvg.textContent = avg.toFixed(2);
    els.statMax.textContent = String(Math.max(...counts));
    els.statMin.textContent = String(Math.min(...counts));
    els.statMed.textContent = String(median(counts));
  }

  function timeLinearScale() {
    return {
      type: 'linear',
      ticks: { callback: (v) => fmtClock(v) },
    };
  }

  function zoomPluginOptions() {
    return {
      pan: { enabled: true, mode: 'x' },
      zoom: {
        wheel: { enabled: true },
        pinch: { enabled: true },
        drag: { enabled: false },
        mode: 'x',
      },
    };
  }

  function renderIpsChart(filteredEvents) {
    const downAll = filteredEvents.filter((e) => e.d);
    const label = unitLabel(state.bucketMs);

    const overall = computeBuckets(downAll, state.rangeStart, state.rangeEnd, state.bucketMs);
    renderStats(overall.counts);

    const datasets = [
      {
        label: '전체',
        data: overall.times.map((t, i) => ({ x: t, y: overall.counts[i] })),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.35)',
        borderWidth: 2,
        pointRadius: state.ipsChartType === 'line' ? 1.5 : 0,
      },
    ];

    const palette = ['#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#eab308', '#ec4899'];
    let ci = 0;
    for (const k of state.selectedKeys) {
      const keyDown = downAll.filter((e) => e.k === k);
      const b = computeBuckets(keyDown, state.rangeStart, state.rangeEnd, state.bucketMs);
      datasets.push({
        label: k,
        data: b.times.map((t, i) => ({ x: t, y: b.counts[i] })),
        borderColor: palette[ci % palette.length],
        backgroundColor: palette[ci % palette.length] + '55',
        borderWidth: 1,
        pointRadius: 0,
      });
      ci++;
    }

    if (ipsChart) {
      ipsChart.destroy();
      ipsChart = null;
    }

    ipsChart = new Chart(els.ipsCanvas, {
      type: state.ipsChartType,
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: timeLinearScale(),
          y: { beginAtZero: true, title: { display: true, text: label } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => (items.length ? fmtClock(items[0].parsed.x) : ''),
              label: (item) => `${item.dataset.label}: ${item.parsed.y}`,
            },
          },
          zoom: zoomPluginOptions(),
          legend: { position: 'bottom' },
        },
      },
    });
  }

  // collapse raw down/up events (with key-repeat down events) into press intervals
  function buildIntervals(events) {
    const sorted = [...events].sort((a, b) => a.t - b.t);
    const intervals = [];
    let openStart = null;
    for (const e of sorted) {
      if (e.d) {
        if (openStart === null) openStart = e.t;
      } else if (openStart !== null) {
        intervals.push([openStart, e.t]);
        openStart = null;
      }
    }
    if (openStart !== null) intervals.push([openStart, state.rangeEnd]);
    return intervals;
  }

  function renderKeyPlots(filteredEvents) {
    els.keyPlots.innerHTML = '';
    for (const [, c] of keyCharts) c.destroy();
    keyCharts.clear();

    const keys = Array.from(state.selectedKeys).sort((a, b) => a.localeCompare(b));
    if (keys.length === 0) {
      els.keyPlots.innerHTML = '<div class="empty-note">키를 선택하면 상세 plot이 표시됩니다.</div>';
      return;
    }

    const rangeSpan = Math.max(1, state.rangeEnd - state.rangeStart);
    const minVisualMs = rangeSpan * 0.001;

    for (const k of keys) {
      const block = document.createElement('div');
      block.className = 'key-plot-block';

      const row = document.createElement('div');
      row.className = 'key-plot-row';
      const nameEl = document.createElement('div');
      nameEl.className = 'key-name';
      nameEl.textContent = k;
      const wrap = document.createElement('div');
      wrap.className = 'chart-wrap';
      const savedHeight = state.keyPlotHeights.get(k);
      if (savedHeight) wrap.style.height = `${savedHeight}px`;
      const canvas = document.createElement('canvas');
      wrap.appendChild(canvas);
      row.appendChild(nameEl);
      row.appendChild(wrap);

      const handle = document.createElement('div');
      handle.className = 'resize-handle resize-handle-sm';
      handle.title = '드래그해서 세로 크기 조절';
      handle.appendChild(document.createElement('span'));

      block.appendChild(row);
      block.appendChild(handle);
      els.keyPlots.appendChild(block);

      const keyEvents = filteredEvents.filter((e) => e.k === k);

      let chart;
      if (state.keyPlotMode === 'raster') {
        const downs = keyEvents.filter((e) => e.d);
        chart = new Chart(canvas, {
          type: 'bar',
          data: {
            datasets: [
              {
                label: k,
                data: downs.map((e) => ({ x: e.t, y: 1 })),
                backgroundColor: '#3b82f6',
                barThickness: 3,
              },
            ],
          },
          options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { type: 'linear', min: state.rangeStart, max: state.rangeEnd, ticks: { callback: (v) => fmtClock(v) } },
              y: { min: 0, max: 1, display: false },
            },
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { title: (items) => (items.length ? fmtClock(items[0].parsed.x) : '') } },
              zoom: zoomPluginOptions(),
            },
          },
        });
      } else {
        const intervals = buildIntervals(keyEvents);
        const points = [{ x: state.rangeStart, y: 0 }];
        for (const [s, eRaw] of intervals) {
          const e = Math.max(eRaw, s + minVisualMs);
          points.push({ x: s, y: 0 }, { x: s, y: 1 }, { x: e, y: 1 }, { x: e, y: 0 });
        }
        points.push({ x: state.rangeEnd, y: 0 });

        chart = new Chart(canvas, {
          type: 'line',
          data: {
            datasets: [
              {
                label: k,
                data: points,
                borderColor: '#3b82f6',
                borderWidth: 2,
                pointRadius: 0,
                stepped: false,
                fill: false,
              },
            ],
          },
          options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { type: 'linear', min: state.rangeStart, max: state.rangeEnd, ticks: { callback: (v) => fmtClock(v) } },
              y: { min: 0, max: 1, display: false },
            },
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { title: (items) => (items.length ? fmtClock(items[0].parsed.x) : '') } },
              zoom: zoomPluginOptions(),
            },
          },
        });
      }

      keyCharts.set(k, chart);
      makeVerticallyResizable(wrap, handle, () => keyCharts.get(k), {
        minHeight: 40,
        maxHeight: 500,
        onHeightChange: (h) => state.keyPlotHeights.set(k, h),
      });
    }
  }

  function render() {
    const filtered = getFilteredEvents();
    if (state.activeTab === 'ips') {
      renderIpsChart(filtered);
    } else {
      renderKeyPlots(filtered);
    }
  }

  function makeVerticallyResizable(wrapEl, handleEl, getChart, options) {
    const opts = options || {};
    const MIN_HEIGHT = opts.minHeight || 150;
    const MAX_HEIGHT = opts.maxHeight || 900;
    let startY = 0;
    let startHeight = 0;

    const onPointerMove = (ev) => {
      const delta = ev.clientY - startY;
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + delta));
      wrapEl.style.height = `${next}px`;
      const chart = getChart();
      if (chart) chart.resize();
      if (opts.onHeightChange) opts.onHeightChange(next);
    };

    const onPointerUp = (ev) => {
      handleEl.classList.remove('dragging');
      handleEl.releasePointerCapture(ev.pointerId);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };

    handleEl.addEventListener('pointerdown', (ev) => {
      startY = ev.clientY;
      startHeight = wrapEl.getBoundingClientRect().height;
      handleEl.classList.add('dragging');
      handleEl.setPointerCapture(ev.pointerId);
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });
  }

  function switchTab(tab) {
    state.activeTab = tab;
    els.tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    els.tabPanels.forEach((p) => p.classList.toggle('tab-hidden', p.dataset.tabPanel !== tab));
    render();
  }

  function init() {
    els.startInput = document.getElementById('rangeStart');
    els.endInput = document.getElementById('rangeEnd');
    els.keyGrid = document.getElementById('keyGrid');
    els.keySearch = document.getElementById('keySearch');
    els.selectAllBtn = document.getElementById('selectAllKeys');
    els.selectNoneBtn = document.getElementById('selectNoneKeys');
    els.bucketButtons = document.querySelectorAll('[data-bucket]');
    els.ipsTypeButtons = document.querySelectorAll('[data-ips-type]');
    els.keyModeButtons = document.querySelectorAll('[data-key-mode]');
    els.tabButtons = document.querySelectorAll('[data-tab]');
    els.tabPanels = document.querySelectorAll('[data-tab-panel]');
    els.statAvg = document.getElementById('statAvg');
    els.statMax = document.getElementById('statMax');
    els.statMin = document.getElementById('statMin');
    els.statMed = document.getElementById('statMed');
    els.ipsCanvas = document.getElementById('ipsChart');
    els.ipsChartWrap = document.getElementById('ipsChartWrap');
    els.ipsResizeHandle = document.getElementById('ipsResizeHandle');
    els.keyPlots = document.getElementById('keyPlots');
    els.emptyNote = document.getElementById('emptyNote');

    if (typeof Chart !== 'undefined' && window.ChartZoom) {
      Chart.register(window.ChartZoom);
    }

    makeVerticallyResizable(els.ipsChartWrap, els.ipsResizeHandle, () => ipsChart, { minHeight: 150, maxHeight: 900 });

    if (RAW_EVENTS.length === 0) {
      els.emptyNote.style.display = 'block';
      document.getElementById('mainPanels').style.display = 'none';
      return;
    }

    const times = RAW_EVENTS.map((e) => e.t);
    state.rangeStart = Math.min(...times);
    state.rangeEnd = Math.max(...times);
    els.startInput.value = fmtDateTimeLocal(state.rangeStart);
    els.endInput.value = fmtDateTimeLocal(state.rangeEnd);

    const keys = getDistinctKeys();
    buildKeyFilterUI(keys, els.keySearch.value);

    els.keySearch.addEventListener('input', () => {
      buildKeyFilterUI(keys, els.keySearch.value);
    });

    els.startInput.addEventListener('change', () => {
      const v = parseDateTimeLocal(els.startInput.value);
      if (v !== null) state.rangeStart = v;
      render();
    });
    els.endInput.addEventListener('change', () => {
      const v = parseDateTimeLocal(els.endInput.value);
      if (v !== null) state.rangeEnd = v;
      render();
    });

    els.selectAllBtn.addEventListener('click', () => {
      state.selectedKeys = new Set(keys);
      buildKeyFilterUI(keys, els.keySearch.value);
      render();
    });
    els.selectNoneBtn.addEventListener('click', () => {
      state.selectedKeys.clear();
      buildKeyFilterUI(keys, els.keySearch.value);
      render();
    });

    els.bucketButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.bucketMs = Number(btn.dataset.bucket);
        els.bucketButtons.forEach((b) => b.classList.toggle('active', b === btn));
        render();
      });
    });
    els.ipsTypeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.ipsChartType = btn.dataset.ipsType;
        els.ipsTypeButtons.forEach((b) => b.classList.toggle('active', b === btn));
        render();
      });
    });
    els.keyModeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.keyPlotMode = btn.dataset.keyMode;
        els.keyModeButtons.forEach((b) => b.classList.toggle('active', b === btn));
        render();
      });
    });
    els.tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
