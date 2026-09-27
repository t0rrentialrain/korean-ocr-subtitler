// Korean OCR Subtitle Extractor — content script
// Runs on https://www.youtube.com/watch* (see manifest.json).
// Loaded AFTER vendor/tesseract/tesseract.min.js, so `Tesseract` is a global here.

(function () {
  'use strict';
  if (window.__koOcrSubExtInjected) return;
  window.__koOcrSubExtInjected = true;

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const SAMPLE_INTERVAL_MS = 300;   // how often we look at the video, at 1x playback
  const MIN_SAMPLE_INTERVAL_MS = 90; // floor, so very high capture speeds don't hammer the CPU
  const STABILITY_TICKS = 2;        // consecutive stable ticks before we trust a change
  const CHANGE_THRESHOLD = 14;      // mean abs grayscale diff (0-255) to call two frames "different"
  const CAPTURE_SPEEDS = [1, 2, 4]; // options exposed in the panel
  const DIFF_W = 48, DIFF_H = 18;   // tiny canvas used only for change detection
  const OCR_TARGET_HEIGHT = 110;    // upscale crop so text is tall enough for Tesseract
  const OCR_MAX_SCALE = 4;
  const MIN_CUE_DURATION = 0.5;     // seconds, floor applied at export time

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    video: null,
    videoId: null,
    region: null,        // {x,y,w,h} fractions of the <video> element's box
    capturing: false,
    enhanceLightText: true,
    captureSpeed: 2,
    worker: null,
    workerReady: false,
    timer: null,
    cues: [],             // finalized {start,end,text}
    currentCue: null,     // {start,text} in progress
    lastAcceptedSig: null,
    candidateSig: null,
    candidateStableTicks: 0,
    candidateStartTime: 0,
    ocrBusy: false,
    lastRecognizedText: '',
  };

  // ---------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------
  function getVideoEl() {
    return document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
  }

  function getVideoIdFromUrl() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('v') || location.pathname;
    } catch {
      return location.href;
    }
  }

  function regionStorageKey(videoId) {
    return `ko-ocr-region:${videoId}`;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function formatTimestamp(t) {
    t = Math.max(0, t);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    const pad = (n, z = 2) => String(n).padStart(z, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }

  function suggestedFilename() {
    const title = document.title.replace(/ - YouTube$/, '').trim();
    const slug = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'youtube_ocr';
    return `${slug}.srt`;
  }

  // ---------------------------------------------------------------------
  // Persistence (per-video region)
  // ---------------------------------------------------------------------
  function saveRegion(region) {
    state.region = region;
    chrome.storage.local.set({ [regionStorageKey(state.videoId)]: region });
    render();
  }

  function loadRegionForCurrentVideo() {
    return new Promise((resolve) => {
      chrome.storage.local.get([regionStorageKey(state.videoId)], (res) => {
        state.region = res[regionStorageKey(state.videoId)] || null;
        resolve(state.region);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Region selection (drag a box over the rendered video)
  // ---------------------------------------------------------------------
  function enterRegionSelectMode() {
    const video = state.video;
    if (!video) { setStatus('No video found yet — wait for the page to load.'); return; }
    const rect = video.getBoundingClientRect();

    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed; left:${rect.left}px; top:${rect.top}px; width:${rect.width}px; height:${rect.height}px; z-index:2147483647; cursor:crosshair; background:rgba(0,0,0,0.15);`;
    const box = document.createElement('div');
    box.style.cssText = `position:absolute; border:2px solid #4da3ff; background:rgba(77,163,255,0.18); display:none; box-sizing:border-box;`;
    const hint = document.createElement('div');
    hint.textContent = 'Drag a box around the Korean subtitle area. Esc to cancel.';
    hint.style.cssText = `position:absolute; top:8px; left:50%; transform:translateX(-50%); background:#111; color:#fff; padding:6px 10px; border-radius:6px; font:13px/1.3 system-ui,sans-serif; pointer-events:none;`;
    overlay.appendChild(box);
    overlay.appendChild(hint);
    document.body.appendChild(overlay);

    let startX = 0, startY = 0, dragging = false;

    function toLocal(clientX, clientY) {
      return { x: clamp(clientX - rect.left, 0, rect.width), y: clamp(clientY - rect.top, 0, rect.height) };
    }

    function cleanup() {
      overlay.remove();
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    }

    function onUp(e) {
      if (!dragging) { cleanup(); return; }
      dragging = false;
      const p = toLocal(e.clientX, e.clientY);
      const x = Math.min(p.x, startX), y = Math.min(p.y, startY);
      const w = Math.abs(p.x - startX), h = Math.abs(p.y - startY);
      cleanup();
      if (w < 10 || h < 10) { setStatus('Region selection cancelled (box too small).'); return; }
      saveRegion({ x: x / rect.width, y: y / rect.height, w: w / rect.width, h: h / rect.height });
      setStatus('Subtitle region saved.');
    }

    function onKey(e) { if (e.key === 'Escape') cleanup(); }

    overlay.addEventListener('mousedown', (e) => {
      dragging = true;
      const p = toLocal(e.clientX, e.clientY);
      startX = p.x; startY = p.y;
      Object.assign(box.style, { left: `${startX}px`, top: `${startY}px`, width: '0px', height: '0px', display: 'block' });
    });
    overlay.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const p = toLocal(e.clientX, e.clientY);
      const x = Math.min(p.x, startX), y = Math.min(p.y, startY);
      const w = Math.abs(p.x - startX), h = Math.abs(p.y - startY);
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
  }

  // ---------------------------------------------------------------------
  // Frame capture / cropping
  // ---------------------------------------------------------------------
  function cropRectPx() {
    const video = state.video, region = state.region;
    if (!video || !region || !video.videoWidth) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    const sw = Math.round(region.w * vw), sh = Math.round(region.h * vh);
    if (sw <= 0 || sh <= 0) return null;
    return {
      sx: Math.round(region.x * vw),
      sy: Math.round(region.y * vh),
      sw, sh,
    };
  }

  function drawDiffCanvas() {
    const r = cropRectPx();
    if (!r) return null;
    const c = drawDiffCanvas._c || (drawDiffCanvas._c = document.createElement('canvas'));
    c.width = DIFF_W; c.height = DIFF_H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(state.video, r.sx, r.sy, r.sw, r.sh, 0, 0, DIFF_W, DIFF_H);
    const data = ctx.getImageData(0, 0, DIFF_W, DIFF_H).data;
    const gray = new Uint8ClampedArray(DIFF_W * DIFF_H);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11);
    }
    return gray;
  }

  function diffDistance(a, b) {
    if (!a || !b) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  function drawOcrCanvas() {
    const r = cropRectPx();
    if (!r) return null;
    const scale = clamp(OCR_TARGET_HEIGHT / r.sh, 1, OCR_MAX_SCALE);
    const dw = Math.round(r.sw * scale), dh = Math.round(r.sh * scale);
    const canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(state.video, r.sx, r.sy, r.sw, r.sh, 0, 0, dw, dh);
    if (state.enhanceLightText) binarizeLightText(ctx, dw, dh);
    return canvas;
  }

  // Heuristic aimed at burned-in Korean captions, which are almost always
  // white or yellow text with a dark outline over a busy video background.
  // Pixels with high "lightness" (regardless of hue) become black text on a
  // white background, which OCR engines are generally tuned for.
  function binarizeLightText(ctx, w, h, threshold = 0.68) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
      const v = l > threshold ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------------
  // OCR worker
  // ---------------------------------------------------------------------
  async function getWorker() {
    if (state.worker) return state.worker;
    setStatus('Loading OCR engine (first run only)…');
    const worker = await Tesseract.createWorker('kor', Tesseract.OEM.LSTM_ONLY, {
      workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('vendor/tesseract/core'),
      langPath: chrome.runtime.getURL('vendor/tesseract/lang'),
      workerBlobURL: false,
      gzip: true,
      logger: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
    state.worker = worker;
    state.workerReady = true;
    return worker;
  }

  function looksLikeRealCaption(text) {
    if (!text) return false;
    const hasHangul = /[\u{AC00}-\u{D7A3}]/u.test(text);
    return hasHangul || text.length >= 2;
  }

  async function runOcrOnCandidate(startTime) {
    state.ocrBusy = true;
    try {
      const canvas = drawOcrCanvas();
      if (!canvas) return;
      const worker = await getWorker();
      const { data } = await worker.recognize(canvas);
      const text = (data.text || '').trim().replace(/\s+/g, ' ');
      closeCurrentCue(startTime);
      if (looksLikeRealCaption(text)) {
        state.currentCue = { start: startTime, end: state.video.currentTime, text };
        state.lastRecognizedText = text;
      } else {
        state.lastRecognizedText = '(blank)';
      }
      setStatus(null); // refresh with current counts
    } catch (err) {
      console.error('[Korean OCR Subtitler] OCR error', err);
      setStatus(`OCR error: ${err.message || err}`);
    } finally {
      state.ocrBusy = false;
    }
  }

  function closeCurrentCue(endTime) {
    if (state.currentCue) {
      state.currentCue.end = endTime;
      if (state.currentCue.text) state.cues.push(state.currentCue);
    }
    state.currentCue = null;
  }

  // ---------------------------------------------------------------------
  // Sampling loop
  // ---------------------------------------------------------------------
  function tick() {
    const video = state.video;
    if (!video || video.paused || video.ended || !state.region) return;

    const sig = drawDiffCanvas();
    if (!sig) return;

    const distFromAccepted = diffDistance(sig, state.lastAcceptedSig);
    if (distFromAccepted <= CHANGE_THRESHOLD) {
      if (state.currentCue) state.currentCue.end = video.currentTime;
      return;
    }

    // Content differs from what's currently accepted — debounce before trusting it.
    const distFromCandidate = diffDistance(sig, state.candidateSig);
    if (state.candidateSig && distFromCandidate <= CHANGE_THRESHOLD) {
      state.candidateStableTicks++;
    } else {
      state.candidateSig = sig;
      state.candidateStableTicks = 1;
      state.candidateStartTime = video.currentTime;
    }

    if (state.candidateStableTicks >= STABILITY_TICKS && !state.ocrBusy) {
      state.lastAcceptedSig = state.candidateSig;
      const startTime = state.candidateStartTime;
      state.candidateSig = null;
      state.candidateStableTicks = 0;
      runOcrOnCandidate(startTime);
    }
  }

  function startCapture() {
    if (!state.region) { setStatus('Set a subtitle region first.'); return; }
    if (!state.video) { setStatus('No video found yet.'); return; }
    if (state.capturing) return;
    state.capturing = true;
    state.lastAcceptedSig = null;
    state.candidateSig = null;
    state.candidateStableTicks = 0;

    state.video.playbackRate = state.captureSpeed;
    state.video.play().catch(() => {});

    const interval = clamp(SAMPLE_INTERVAL_MS / state.captureSpeed, MIN_SAMPLE_INTERVAL_MS, SAMPLE_INTERVAL_MS);
    state.timer = setInterval(tick, interval);
    setStatus(`Watching for captions… (${state.captureSpeed}x)`);
    getWorker().catch((e) => setStatus(`Failed to load OCR engine: ${e.message || e}`));
  }

  function stopCapture() {
    if (!state.capturing) return;
    state.capturing = false;
    clearInterval(state.timer);
    state.timer = null;
    if (state.video) {
      closeCurrentCue(state.video.currentTime);
      state.video.playbackRate = 1;
    }
    setStatus('Stopped.');
  }

  function clearCues() {
    state.cues = [];
    state.currentCue = null;
    state.lastAcceptedSig = null;
    state.candidateSig = null;
    state.lastRecognizedText = '';
    setStatus('Cleared.');
  }

  function allCuesForExport() {
    const cues = state.cues.slice();
    if (state.currentCue && state.currentCue.text) {
      cues.push({ ...state.currentCue, end: state.video ? state.video.currentTime : state.currentCue.end });
    }
    return cues
      .map((c) => (c.end - c.start < MIN_CUE_DURATION ? { ...c, end: c.start + MIN_CUE_DURATION } : c))
      .filter((c) => c.text && c.text.trim().length > 0);
  }

  function buildSrt(cues) {
    return cues
      .map((c, i) => `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}\n`)
      .join('\n');
  }

  function downloadSrt() {
    const cues = allCuesForExport();
    if (cues.length === 0) { setStatus('Nothing to export yet.'); return; }
    const text = buildSrt(cues);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(`Exported ${cues.length} lines.`);
  }

  // ---------------------------------------------------------------------
  // Floating panel UI (Shadow DOM so YouTube's CSS can't touch it)
  // ---------------------------------------------------------------------
  let shadow = null;
  let els = {};

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'ko-ocr-sub-host';
    host.style.cssText = 'all:initial; position:fixed; top:80px; right:20px; z-index:2147483647;';
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel { font: 13px/1.4 system-ui, -apple-system, sans-serif; width: 260px; background: #14141c;
          color: #eee; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.5); overflow: hidden;
          border: 1px solid #2c2c3a; }
        .header { background: #1f1f2c; padding: 8px 10px; cursor: move; display: flex;
          align-items: center; justify-content: space-between; user-select: none; }
        .title { font-weight: 600; font-size: 12.5px; }
        .collapse-btn { background: none; border: none; color: #aaa; cursor: pointer; font-size: 14px; padding: 0 4px; }
        .body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        .body.hidden { display: none; }
        button { background: #2b2b3d; color: #fff; border: 1px solid #3a3a50; border-radius: 6px;
          padding: 6px 8px; font-size: 12.5px; cursor: pointer; }
        button:hover { background: #38384f; }
        button:disabled { opacity: .45; cursor: not-allowed; }
        button.primary { background: #3568d4; border-color: #3568d4; }
        button.primary:hover { background: #4477e6; }
        button.danger { background: #5a2a2a; border-color: #6a3333; }
        button.speed.active { background: #3568d4; border-color: #3568d4; }
        .row { display: flex; gap: 6px; }
        .row > button { flex: 1; }
        .speed-row { display: flex; align-items: center; gap: 6px; }
        .speed-row .speed-label { font-size: 11.5px; color: #ccc; }
        .speed-row .speeds { display: flex; gap: 4px; flex: 1; }
        .speed-row .speeds button { flex: 1; padding: 4px 0; }
        .status { font-size: 11.5px; color: #aab; min-height: 28px; white-space: pre-wrap; }
        .preview { font-size: 12px; color: #ffd479; border-top: 1px solid #2c2c3a; padding-top: 6px;
          min-height: 16px; word-break: break-word; }
        label.opt { font-size: 11.5px; color: #ccc; display: flex; align-items: center; gap: 6px; }
        .count { color: #7fd17f; font-weight: 600; }
      </style>
      <div class="panel">
        <div class="header" id="drag-handle">
          <span class="title">🇰🇷 OCR Subtitler</span>
          <button class="collapse-btn" id="collapse">–</button>
        </div>
        <div class="body" id="body">
          <button id="setRegion">🎯 Set Subtitle Region</button>
          <div class="row">
            <button id="start" class="primary">▶ Start</button>
            <button id="stop">⏹ Stop</button>
          </div>
          <div class="speed-row">
            <span class="speed-label">Speed:</span>
            <div class="speeds" id="speeds"></div>
          </div>
          <label class="opt"><input type="checkbox" id="enhance" checked> Enhance light-colored text</label>
          <div class="row">
            <button id="download">⬇ Export .srt</button>
            <button id="clear" class="danger">🗑 Clear</button>
          </div>
          <div class="status" id="status">Set a subtitle region to begin.</div>
          <div class="preview" id="preview"></div>
        </div>
      </div>
    `;

    els = {
      collapse: shadow.getElementById('collapse'),
      body: shadow.getElementById('body'),
      setRegion: shadow.getElementById('setRegion'),
      start: shadow.getElementById('start'),
      stop: shadow.getElementById('stop'),
      enhance: shadow.getElementById('enhance'),
      download: shadow.getElementById('download'),
      clear: shadow.getElementById('clear'),
      status: shadow.getElementById('status'),
      preview: shadow.getElementById('preview'),
      dragHandle: shadow.getElementById('drag-handle'),
      speeds: shadow.getElementById('speeds'),
      speedButtons: [],
      host,
    };

    CAPTURE_SPEEDS.forEach((speed) => {
      const btn = document.createElement('button');
      btn.className = 'speed';
      btn.textContent = `${speed}x`;
      btn.addEventListener('click', () => {
        state.captureSpeed = speed;
        els.speedButtons.forEach((b) => b.classList.toggle('active', Number(b.textContent.replace('x', '')) === speed));
      });
      els.speeds.appendChild(btn);
      els.speedButtons.push(btn);
    });
    els.speedButtons.forEach((b) => b.classList.toggle('active', Number(b.textContent.replace('x', '')) === state.captureSpeed));

    els.setRegion.addEventListener('click', enterRegionSelectMode);
    els.start.addEventListener('click', startCapture);
    els.stop.addEventListener('click', stopCapture);
    els.download.addEventListener('click', downloadSrt);
    els.clear.addEventListener('click', clearCues);
    els.enhance.addEventListener('change', () => { state.enhanceLightText = els.enhance.checked; });
    els.collapse.addEventListener('click', () => {
      els.body.classList.toggle('hidden');
      els.collapse.textContent = els.body.classList.contains('hidden') ? '+' : '–';
    });

    makeDraggable(host, els.dragHandle);
  }

  function makeDraggable(host, handle) {
    let dragging = false, offX = 0, offY = 0;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = host.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      host.style.left = `${clamp(e.clientX - offX, 0, window.innerWidth - 40)}px`;
      host.style.top = `${clamp(e.clientY - offY, 0, window.innerHeight - 40)}px`;
      host.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function setStatus(msg) {
    if (msg) state._lastStatusMsg = msg;
    if (!els.status) return;
    const lineCount = state.cues.length + (state.currentCue ? 1 : 0);
    const regionTxt = state.region ? 'set ✅' : 'not set ⚠️';
    els.start.disabled = !state.region || state.capturing;
    els.stop.disabled = !state.capturing;
    els.download.disabled = lineCount === 0;
    if (els.speedButtons) els.speedButtons.forEach((b) => { b.disabled = state.capturing; });
    els.status.innerHTML = `Region: ${regionTxt} &nbsp;|&nbsp; Lines: <span class="count">${lineCount}</span>\n${state._lastStatusMsg || ''}`;
    els.preview.textContent = state.lastRecognizedText ? `“${state.lastRecognizedText}”` : '';
  }

  function render() { setStatus(null); }

  // ---------------------------------------------------------------------
  // Video / SPA-navigation lifecycle
  // ---------------------------------------------------------------------
  async function handleVideoChange() {
    stopCapture();
    state.cues = [];
    state.currentCue = null;
    state.lastRecognizedText = '';
    state.video = getVideoEl();
    state.videoId = getVideoIdFromUrl();
    await loadRegionForCurrentVideo();
    if (state.video) {
      state.video.playbackRate = 1;
      state.video.addEventListener('seeking', () => {
        state.lastAcceptedSig = null;
        state.candidateSig = null;
        state.candidateStableTicks = 0;
      });
      state.video.addEventListener('ended', () => {
        if (state.capturing) { stopCapture(); setStatus('Video ended — capture stopped automatically.'); }
      });
    }
    render();
  }

  function waitForVideo(cb) {
    const existing = getVideoEl();
    if (existing) { cb(existing); return; }
    const obs = new MutationObserver(() => {
      const v = getVideoEl();
      if (v) { obs.disconnect(); cb(v); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    buildPanel();
    waitForVideo(() => handleVideoChange());

    // YouTube is an SPA; watch for in-page navigation between videos.
    document.addEventListener('yt-navigate-finish', () => waitForVideo(() => handleVideoChange()));
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        waitForVideo(() => handleVideoChange());
      }
    }, 1000);

    window.addEventListener('pagehide', () => {
      if (state.worker) state.worker.terminate().catch(() => {});
    });
  }

  // ---------------------------------------------------------------------
  // Messaging (popup <-> content script)
  // ---------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'GET_STATE':
        sendResponse({
          capturing: state.capturing,
          regionSet: !!state.region,
          lineCount: state.cues.length + (state.currentCue ? 1 : 0),
          lastText: state.lastRecognizedText,
        });
        break;
      case 'SET_REGION': enterRegionSelectMode(); sendResponse({ ok: true }); break;
      case 'START': startCapture(); sendResponse({ ok: true }); break;
      case 'STOP': stopCapture(); sendResponse({ ok: true }); break;
      case 'DOWNLOAD': downloadSrt(); sendResponse({ ok: true }); break;
      case 'CLEAR': clearCues(); sendResponse({ ok: true }); break;
      default: break;
    }
    return true;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
