(function () {
  let RAW_EVENTS = Array.isArray(window.__EVENTS__) ? window.__EVENTS__ : [];
  let allKeys = [];

  const state = {
    rangeStart: 0,
    rangeEnd: 0,
    selectedKeys: new Set(),
    bucketMs: 1000,
    ipsChartType: 'line',
    keyPlotMode: 'raster',
    activeTab: 'ips',
    keyPlotHeights: new Map(),
    playback: {
      playing: false,
      posMs: 0,
      speed: 1,
      noteSpeedPxPerSec: 300,
      noteW: 24,
      noteH: 24,
      lastPerf: 0,
    },
  };

  const els = {};
  let ipsChart = null;
  const keyCharts = new Map();
  let playbackKeys = [];
  let playbackRafId = null;

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

  // spanMs: 현재 축에 보이는 시간 범위. 좁을수록(확대될수록) 소수점 자리수를 늘린다.
  function pickDecimals(spanMs) {
    if (spanMs < 100) return 3;
    if (spanMs < 1000) return 2;
    if (spanMs < 10000) return 1;
    return 0;
  }

  function fmtClockAdaptive(ms, spanMs) {
    const decimals = pickDecimals(spanMs);
    const base = fmtClock(ms);
    if (decimals === 0) return base;
    const msPart = String(new Date(ms).getMilliseconds()).padStart(3, '0').slice(0, decimals);
    return `${base}.${msPart}`;
  }

  // Chart.js가 tick callback을 스케일 인스턴스에 바인딩해서(this=scale) 호출하므로
  // 화살표 함수가 아닌 일반 함수여야 this.min/this.max로 현재 확대 범위를 읽을 수 있다.
  function adaptiveTickCallback(value) {
    const span = this.max - this.min;
    return fmtClockAdaptive(value, span);
  }

  function adaptiveTooltipTitle(items) {
    if (!items.length) return '';
    const scale = items[0].chart.scales.x;
    const span = scale.max - scale.min;
    return fmtClockAdaptive(items[0].parsed.x, span);
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
      ticks: { callback: adaptiveTickCallback },
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
              title: adaptiveTooltipTitle,
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
              x: { type: 'linear', min: state.rangeStart, max: state.rangeEnd, ticks: { callback: adaptiveTickCallback } },
              y: { min: 0, max: 1, display: false },
            },
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { title: adaptiveTooltipTitle } },
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
              x: { type: 'linear', min: state.rangeStart, max: state.rangeEnd, ticks: { callback: adaptiveTickCallback } },
              y: { min: 0, max: 1, display: false },
            },
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { title: adaptiveTooltipTitle } },
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
    } else if (state.activeTab === 'details') {
      renderKeyPlots(filtered);
    } else if (state.activeTab === 'playback') {
      resetPlayback();
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
    if (state.activeTab === 'playback' && tab !== 'playback') {
      stopPlaybackLoop();
    }
    state.activeTab = tab;
    els.tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    els.tabPanels.forEach((p) => p.classList.toggle('tab-hidden', p.dataset.tabPanel !== tab));
    render();
  }

  // ------------------------------
  // 시각화 재생 ("음악 게임 노트"식 canvas 애니메이션)
  // 각 선택된 키는 같은 X, 다른 Y에 생성 지점(레인)을 가지며, 눌린 시점에 그 위치에서
  // 노트가 생성되어 오른쪽으로 등속 이동하다 캔버스 밖으로 나가면 사라진다.
  // ------------------------------
  const PLAYBACK_SPAWN_X = 70;
  const PLAYBACK_TOP_MARGIN = 36; // progress 텍스트 공간
  const PLAYBACK_LANE_PADDING = 16;

  function getPlaybackKeys() {
    return Array.from(state.selectedKeys).sort((a, b) => a.localeCompare(b));
  }

  function layoutPlaybackCanvas() {
    const wrap = els.playbackCanvasWrap;
    const canvas = els.playbackCanvas;
    const width = Math.max(320, wrap.clientWidth);
    const laneH = Math.max(state.playback.noteH + PLAYBACK_LANE_PADDING, 40);
    const height = PLAYBACK_TOP_MARGIN + laneH * Math.max(1, playbackKeys.length);

    canvas.width = width;
    canvas.height = height;
    canvas.style.height = `${height}px`;
    return { width, height, laneH };
  }

  function laneCenterY(index, laneH) {
    return PLAYBACK_TOP_MARGIN + laneH * index + laneH / 2;
  }

  function drawPlaybackFrame() {
    const canvas = els.playbackCanvas;
    const ctx = canvas.getContext('2d');
    const { width, height, laneH } = layoutPlaybackCanvas();

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#000';
    ctx.font = '13px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${Math.floor(state.playback.posMs)}ms`, 8, 8);

    const spawnW = state.playback.noteW + 8;
    const spawnH = state.playback.noteH + 8;
    const noteW = state.playback.noteW;
    const noteH = state.playback.noteH;

    const absNow = state.rangeStart + state.playback.posMs;
    const lifetimeMs = ((width - PLAYBACK_SPAWN_X) / state.playback.noteSpeedPxPerSec) * 1000;

    const downEvents = getFilteredEvents().filter((e) => e.d);

    playbackKeys.forEach((k, i) => {
      const cy = laneCenterY(i, laneH);

      // 입력 노트를 먼저 그린다 (생성 지점 바로 위에 막 생성된 노트가 라벨을 가리지 않도록,
      // 생성 지점+라벨은 항상 마지막에 그려서 위에 보이게 한다).
      for (const e of downEvents) {
        if (e.k !== k) continue;
        const elapsed = absNow - e.t;
        if (elapsed < 0 || elapsed > lifetimeMs) continue;
        const traveled = (elapsed / 1000) * state.playback.noteSpeedPxPerSec;
        const nx = PLAYBACK_SPAWN_X + traveled;

        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.fillRect(nx - noteW / 2, cy - noteH / 2, noteW, noteH);
        ctx.strokeRect(nx - noteW / 2, cy - noteH / 2, noteW, noteH);
      }

      // 생성 지점: 검은 테두리, 흰 배경, 검은 글자
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.fillRect(PLAYBACK_SPAWN_X - spawnW / 2, cy - spawnH / 2, spawnW, spawnH);
      ctx.strokeRect(PLAYBACK_SPAWN_X - spawnW / 2, cy - spawnH / 2, spawnW, spawnH);
      ctx.fillStyle = '#000';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(k, PLAYBACK_SPAWN_X, cy);
    });
  }

  function updatePlaybackProgressBar() {
    const duration = Math.max(1, state.rangeEnd - state.rangeStart);
    const pct = Math.min(100, (state.playback.posMs / duration) * 100);
    els.playbackProgressFill.style.width = `${pct}%`;
  }

  function playbackTick(nowPerf) {
    if (!state.playback.playing) return;
    const dt = nowPerf - state.playback.lastPerf;
    state.playback.lastPerf = nowPerf;
    state.playback.posMs += dt * state.playback.speed;

    const duration = state.rangeEnd - state.rangeStart;
    if (state.playback.posMs >= duration) {
      state.playback.posMs = duration;
      state.playback.playing = false;
      els.playbackToggleBtn.textContent = '▶ 재생';
    }

    drawPlaybackFrame();
    updatePlaybackProgressBar();

    if (state.playback.playing) {
      playbackRafId = requestAnimationFrame(playbackTick);
    }
  }

  function startPlaybackLoop() {
    if (state.playback.playing) return;
    if (state.playback.posMs >= state.rangeEnd - state.rangeStart) {
      state.playback.posMs = 0;
    }
    state.playback.playing = true;
    state.playback.lastPerf = performance.now();
    els.playbackToggleBtn.textContent = '⏸ 정지';
    playbackRafId = requestAnimationFrame(playbackTick);
  }

  function stopPlaybackLoop() {
    state.playback.playing = false;
    if (playbackRafId !== null) {
      cancelAnimationFrame(playbackRafId);
      playbackRafId = null;
    }
    if (els.playbackToggleBtn) els.playbackToggleBtn.textContent = '▶ 재생';
  }

  // 필터/키 선택이 바뀌거나 'playback' 탭에 처음 들어왔을 때: 재생을 멈추고 처음부터 다시 그린다.
  function resetPlayback() {
    stopPlaybackLoop();
    state.playback.posMs = 0;
    playbackKeys = getPlaybackKeys();

    if (playbackKeys.length === 0) {
      els.playbackEmptyNote.style.display = 'block';
      els.playbackArea.style.display = 'none';
      return;
    }

    els.playbackEmptyNote.style.display = 'none';
    els.playbackArea.style.display = '';
    drawPlaybackFrame();
    updatePlaybackProgressBar();
  }

  function recomputeDataBounds() {
    if (RAW_EVENTS.length === 0) return;
    const times = RAW_EVENTS.map((e) => e.t);
    state.dataMin = Math.min(...times);
    state.dataMax = Math.max(...times);
  }

  function rebuildKeyList() {
    allKeys = getDistinctKeys();
    buildKeyFilterUI(allKeys, els.keySearch.value);
  }

  // 데이터가 처음으로 채워졌을 때(최초 로드 또는 빈 상태에서의 첫 갱신) 기본 시점 범위를 설정한다.
  function activateWithData() {
    recomputeDataBounds();
    state.viewNow = Date.now();
    state.rangeEnd = state.viewNow;
    state.rangeStart = state.viewNow - 10 * 60 * 1000;
    els.startInput.value = fmtDateTimeLocal(state.rangeStart);
    els.endInput.value = fmtDateTimeLocal(state.rangeEnd);
    rebuildKeyList();
    els.emptyNote.style.display = 'none';
    document.getElementById('mainPanels').style.display = '';
  }

  function setRefreshStatus(text, isError) {
    els.refreshStatus.textContent = text;
    els.refreshStatus.classList.toggle('error', !!isError);
  }

  async function refreshData() {
    const wasEmpty = RAW_EVENTS.length === 0;
    els.refreshBtn.disabled = true;
    setRefreshStatus('갱신 중...', false);
    try {
      const res = await fetch(window.__REFRESH_URL__, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const events = await res.json();
      if (!Array.isArray(events)) throw new Error('invalid response');

      RAW_EVENTS = events;
      recomputeDataBounds();
      rebuildKeyList();

      if (wasEmpty && RAW_EVENTS.length > 0) {
        activateWithData();
      } else {
        // 종료 시점을 갱신 시점(현재)으로 계속 따라가게 한다.
        state.viewNow = Date.now();
        state.rangeEnd = state.viewNow;
        els.endInput.value = fmtDateTimeLocal(state.rangeEnd);
      }

      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      setRefreshStatus(`마지막 갱신: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, false);
      render();
    } catch (err) {
      setRefreshStatus('갱신 실패 (분석 서버에 연결할 수 없습니다)', true);
    } finally {
      els.refreshBtn.disabled = false;
    }
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
    els.quickRangeButtons = document.querySelectorAll('[data-quick-range]');
    els.statAvg = document.getElementById('statAvg');
    els.statMax = document.getElementById('statMax');
    els.statMin = document.getElementById('statMin');
    els.statMed = document.getElementById('statMed');
    els.ipsCanvas = document.getElementById('ipsChart');
    els.ipsChartWrap = document.getElementById('ipsChartWrap');
    els.ipsResizeHandle = document.getElementById('ipsResizeHandle');
    els.keyPlots = document.getElementById('keyPlots');
    els.emptyNote = document.getElementById('emptyNote');
    els.refreshBtn = document.getElementById('refreshBtn');
    els.refreshStatus = document.getElementById('refreshStatus');
    els.filterHeader = document.getElementById('filterHeader');
    els.filterBody = document.getElementById('filterBody');
    els.filterToggleBtn = document.getElementById('filterToggleBtn');
    els.playbackEmptyNote = document.getElementById('playbackEmptyNote');
    els.playbackArea = document.getElementById('playbackArea');
    els.playbackCanvasWrap = document.getElementById('playbackCanvasWrap');
    els.playbackCanvas = document.getElementById('playbackCanvas');
    els.playbackToggleBtn = document.getElementById('playbackToggleBtn');
    els.playbackSpeed = document.getElementById('playbackSpeed');
    els.playbackNoteSpeed = document.getElementById('playbackNoteSpeed');
    els.playbackNoteW = document.getElementById('playbackNoteW');
    els.playbackNoteH = document.getElementById('playbackNoteH');
    els.playbackProgressFill = document.getElementById('playbackProgressFill');

    if (typeof Chart !== 'undefined' && window.ChartZoom) {
      Chart.register(window.ChartZoom);
    }

    makeVerticallyResizable(els.ipsChartWrap, els.ipsResizeHandle, () => ipsChart, { minHeight: 150, maxHeight: 900 });

    els.refreshBtn.addEventListener('click', refreshData);

    els.filterHeader.addEventListener('click', () => {
      const collapsed = els.filterBody.classList.toggle('collapsed');
      els.filterToggleBtn.classList.toggle('collapsed', collapsed);
    });

    els.keySearch.addEventListener('input', () => {
      buildKeyFilterUI(allKeys, els.keySearch.value);
    });

    if (RAW_EVENTS.length === 0) {
      els.emptyNote.style.display = 'block';
      document.getElementById('mainPanels').style.display = 'none';
    } else {
      activateWithData();
    }

    els.startInput.addEventListener('change', () => {
      const v = parseDateTimeLocal(els.startInput.value);
      if (v !== null) state.rangeStart = v;
      els.quickRangeButtons.forEach((b) => b.classList.remove('active'));
      render();
    });
    els.endInput.addEventListener('change', () => {
      const v = parseDateTimeLocal(els.endInput.value);
      if (v !== null) state.rangeEnd = v;
      els.quickRangeButtons.forEach((b) => b.classList.remove('active'));
      render();
    });

    els.selectAllBtn.addEventListener('click', () => {
      state.selectedKeys = new Set(allKeys);
      buildKeyFilterUI(allKeys, els.keySearch.value);
      render();
    });
    els.selectNoneBtn.addEventListener('click', () => {
      state.selectedKeys.clear();
      buildKeyFilterUI(allKeys, els.keySearch.value);
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

    els.quickRangeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const spec = btn.dataset.quickRange;
        if (spec === 'all') {
          state.rangeStart = state.dataMin;
          state.rangeEnd = state.dataMax;
        } else {
          state.rangeEnd = state.viewNow;
          state.rangeStart = state.viewNow - Number(spec);
        }
        els.startInput.value = fmtDateTimeLocal(state.rangeStart);
        els.endInput.value = fmtDateTimeLocal(state.rangeEnd);
        els.quickRangeButtons.forEach((b) => b.classList.toggle('active', b === btn));
        render();
      });
    });

    els.playbackToggleBtn.addEventListener('click', () => {
      if (state.playback.playing) stopPlaybackLoop();
      else startPlaybackLoop();
    });
    els.playbackSpeed.addEventListener('change', () => {
      state.playback.speed = Number(els.playbackSpeed.value);
    });
    els.playbackNoteSpeed.addEventListener('input', () => {
      state.playback.noteSpeedPxPerSec = Number(els.playbackNoteSpeed.value);
      if (!state.playback.playing) drawPlaybackFrame();
    });
    els.playbackNoteW.addEventListener('input', () => {
      state.playback.noteW = Math.max(4, Number(els.playbackNoteW.value) || 4);
      if (!state.playback.playing) drawPlaybackFrame();
    });
    els.playbackNoteH.addEventListener('input', () => {
      state.playback.noteH = Math.max(4, Number(els.playbackNoteH.value) || 4);
      if (!state.playback.playing) drawPlaybackFrame();
    });

    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
