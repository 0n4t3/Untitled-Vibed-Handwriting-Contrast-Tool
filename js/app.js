(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---- Settings -----------------------------------------------------------

  const DEFAULTS = {
    sensitivity: 60,
    bolden: 0,
    mode: 'binary',
    channel: 'lum',
    bgSize: 4,
    smoothing: 1,
    speck: 4,
    seedRatio: 2,
    procSize: 3000,
  };
  const STORAGE_KEY = 'handwriting-contrast-settings';

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return Object.assign({}, DEFAULTS, saved);
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* private mode etc. */ }
  }

  let settings = loadSettings();

  const RANGES = {
    sensitivity: (v) => String(v),
    bolden: (v) => (v === 0 ? 'Off' : `${v} px`),
    bgSize: (v) => `${v}%`,
    smoothing: (v) => (v === 0 ? 'Off' : String(v)),
    speck: (v) => (v === 0 ? 'Off' : String(v)),
    seedRatio: (v) => `${v.toFixed(1)}×`,
  };

  function syncControls() {
    for (const key of Object.keys(RANGES)) {
      $(key).value = settings[key];
      $(key + 'Out').textContent = RANGES[key](Number(settings[key]));
    }
    $('channel').value = settings.channel;
    $('procSize').value = String(settings.procSize);
    for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === settings.mode;
  }

  function bindControls() {
    for (const key of Object.keys(RANGES)) {
      const el = $(key);
      el.addEventListener('input', () => {
        settings[key] = Number(el.value);
        $(key + 'Out').textContent = RANGES[key](settings[key]);
        saveSettings();
        scheduleProcess(90);
      });
      el.addEventListener('dblclick', () => {
        settings[key] = DEFAULTS[key];
        syncControls();
        saveSettings();
        scheduleProcess(0);
      });
    }
    $('channel').addEventListener('change', (e) => { settings.channel = e.target.value; saveSettings(); scheduleProcess(0); });
    $('procSize').addEventListener('change', (e) => { settings.procSize = Number(e.target.value); saveSettings(); scheduleProcess(0); });
    for (const r of document.querySelectorAll('input[name="mode"]')) {
      r.addEventListener('change', () => { settings.mode = r.value; saveSettings(); scheduleProcess(0); });
    }
    $('resetBtn').addEventListener('click', () => {
      settings = Object.assign({}, DEFAULTS);
      syncControls();
      saveSettings();
      scheduleProcess(0);
    });
  }

  // ---- Images ---------------------------------------------------------------

  const items = [];
  let current = -1;
  let nextId = 1;

  function isImageFile(f) {
    return (f.type && f.type.startsWith('image/')) || /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i.test(f.name);
  }

  async function decode(file) {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      // Fallback path via <img> for formats some browsers only decode there.
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return await createImageBitmap(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  function makeThumb(source, sw, sh) {
    const max = 240;
    const s = Math.min(1, max / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s));
    c.height = Math.max(1, Math.round(sh * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob((b) => resolve(URL.createObjectURL(b)), 'image/jpeg', 0.8));
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter(isImageFile);
    if (!files.length) {
      setStatus('No images found in what was dropped or pasted.');
      return;
    }
    const failed = [];
    let firstNew = -1;
    for (const file of files) {
      let bmp;
      try {
        bmp = await decode(file);
      } catch (e) {
        failed.push(file.name || 'pasted image');
        continue;
      }
      const item = {
        id: nextId++,
        file,
        name: (file.name || `pasted-${Date.now()}.png`).replace(/\.[^.]+$/, ''),
        rotation: 0,
        thumbUrl: await makeThumb(bmp, bmp.width, bmp.height),
        thumbRotation: 0,
        src: null,
        ink: null,
      };
      bmp.close && bmp.close();
      items.push(item);
      if (firstNew < 0) firstNew = items.length - 1;
      renderThumbs();
    }
    if (failed.length) {
      setStatus(`Couldn't read ${failed.join(', ')} — this browser can't decode that format. ` +
        `(iPhone HEIC photos: export or share as JPEG first.)`);
    }
    if (firstNew >= 0) select(firstNew);
    updateButtons();
  }

  function renderThumbs() {
    const ul = $('thumbs');
    ul.textContent = '';
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'thumb' + (i === current ? ' active' : '');
      li.title = item.name;
      li.tabIndex = 0;
      const img = document.createElement('img');
      img.src = item.thumbUrl;
      img.alt = item.name;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Remove';
      del.setAttribute('aria-label', `Remove ${item.name}`);
      del.addEventListener('click', (e) => { e.stopPropagation(); removeItem(i); });
      li.append(img, num, del);
      li.addEventListener('click', () => select(i));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(i); });
      ul.appendChild(li);
    });
  }

  function removeItem(i) {
    const [item] = items.splice(i, 1);
    URL.revokeObjectURL(item.thumbUrl);
    if (!items.length) {
      current = -1;
      lastResult = null;
      $('stage').hidden = true;
      $('empty').hidden = false;
      setStatus('Ready.');
    } else if (i < current || current >= items.length) {
      current = Math.max(0, current - 1);
      select(current, true);
    } else if (i === current) {
      select(current, true);
    }
    renderThumbs();
    updateButtons();
  }

  function select(i, force) {
    if (i < 0 || i >= items.length || (i === current && !force)) return;
    // Only the image on screen keeps its (large) intermediate buffers.
    items.forEach((it, k) => { if (k !== i) { it.src = null; it.ink = null; } });
    current = i;
    zoom = 'fit';
    renderThumbs();
    scheduleProcess(0);
  }

  // ---- Processing -----------------------------------------------------------

  async function getWorking(item) {
    const key = `${settings.procSize}|${item.rotation}`;
    if (item.src && item.src.key === key) return item.src;
    const bmp = await decode(item.file);
    const limit = settings.procSize || Infinity;
    const s = Math.min(1, limit / Math.max(bmp.width, bmp.height));
    const dw = Math.max(1, Math.round(bmp.width * s));
    const dh = Math.max(1, Math.round(bmp.height * s));
    const quarter = item.rotation % 180 !== 0;
    const canvas = document.createElement('canvas');
    canvas.width = quarter ? dh : dw;
    canvas.height = quarter ? dw : dh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height); // flatten transparency onto paper
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((item.rotation * Math.PI) / 180);
    ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
    bmp.close && bmp.close();
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { key, canvas, imageData, w: canvas.width, h: canvas.height };
  }

  // Runs the full pipeline for one item. `keep` caches buffers on the item.
  async function processItem(item, keep) {
    const src = await getWorking(item);
    const { w, h } = src;
    const long = Math.max(w, h);
    const inkKey = `${src.key}|${settings.channel}|${settings.bgSize}|${settings.smoothing}`;
    let ink = item.ink && item.ink.key === inkKey ? item.ink.map : null;
    if (!ink) {
      ink = HWProcess.buildInkMap(src.imageData.data, w, h, {
        channel: settings.channel,
        backgroundRadius: (long * settings.bgSize) / 200,
        smoothing: settings.smoothing,
      });
    }
    const out = HWProcess.render(ink, {
      sensitivity: settings.sensitivity,
      seedRatio: settings.seedRatio,
      speckArea: settings.speck * Math.pow(long / 1000, 2),
      bolden: settings.bolden,
      mode: settings.mode,
    });
    if (keep) {
      item.src = src;
      item.ink = { key: inkKey, map: ink };
    }
    return { src, w, h, gray: out.gray, inkFraction: out.inkFraction };
  }

  const resultKey = (item) => `${item.id}|${item.rotation}|${JSON.stringify(settings)}`;

  let gen = 0;
  let timer = 0;
  let lastResult = null;

  function scheduleProcess(delay) {
    clearTimeout(timer);
    timer = setTimeout(runCurrent, delay);
  }

  const yieldToPaint = () => new Promise((r) => {
    requestAnimationFrame(() => setTimeout(r, 0));
    setTimeout(r, 50); // rAF doesn't fire in background tabs
  });

  async function runCurrent() {
    const item = items[current];
    if (!item) return;
    const my = ++gen;
    showBusy('Processing…');
    await yieldToPaint();
    if (my !== gen) return;
    try {
      const t0 = performance.now();
      const res = await processItem(item, true);
      if (my !== gen) return;
      drawResult(res);
      lastResult = { item, key: resultKey(item), ...res };
      if (item.thumbRotation !== item.rotation) {
        URL.revokeObjectURL(item.thumbUrl);
        item.thumbUrl = await makeThumb(res.src.canvas, res.w, res.h);
        item.thumbRotation = item.rotation;
        renderThumbs();
      }
      const ms = Math.round(performance.now() - t0);
      setStatus(`${item.name} — ${res.w} × ${res.h} px · ink covers ${(res.inkFraction * 100).toFixed(1)}% · ${ms} ms`);
    } catch (e) {
      console.error(e);
      setStatus(`Something went wrong processing ${item.name}: ${e.message || e}`);
    } finally {
      if (my === gen) hideBusy();
      updateButtons();
    }
  }

  function drawResult(res) {
    const before = $('beforeCanvas');
    const after = $('afterCanvas');
    for (const c of [before, after]) {
      if (c.width !== res.w || c.height !== res.h) { c.width = res.w; c.height = res.h; }
    }
    before.getContext('2d').drawImage(res.src.canvas, 0, 0);
    const actx = after.getContext('2d');
    const img = actx.createImageData(res.w, res.h);
    HWProcess.grayToRGBA(res.gray, img.data);
    actx.putImageData(img, 0, 0);
    $('empty').hidden = true;
    $('stage').hidden = false;
    layoutStage();
    updateView();
  }

  // ---- Viewer ---------------------------------------------------------------

  let zoom = 'fit';
  let split = 0.5;
  let peek = false;

  function currentView() {
    if (peek) return 'original';
    return document.querySelector('input[name="view"]:checked').value;
  }

  function fitScale() {
    const v = $('viewer');
    const c = $('afterCanvas');
    const aw = v.clientWidth - 32, ah = v.clientHeight - 32;
    return Math.min(2, aw / c.width, ah / c.height);
  }

  function layoutStage() {
    const c = $('afterCanvas');
    if (!c.width || $('stage').hidden) return;
    const scale = zoom === 'fit' ? fitScale() : zoom;
    const stage = $('stage');
    stage.style.width = `${Math.round(c.width * scale)}px`;
    stage.style.height = `${Math.round(c.height * scale)}px`;
    stage.classList.toggle('pixelated', scale >= 2);
    $('zoomFitBtn').textContent = zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`;
  }

  function setZoom(next) {
    const v = $('viewer');
    const cx = (v.scrollLeft + v.clientWidth / 2) / Math.max(1, v.scrollWidth);
    const cy = (v.scrollTop + v.clientHeight / 2) / Math.max(1, v.scrollHeight);
    zoom = next;
    layoutStage();
    v.scrollLeft = cx * v.scrollWidth - v.clientWidth / 2;
    v.scrollTop = cy * v.scrollHeight - v.clientHeight / 2;
  }

  function zoomBy(f) {
    if (!lastResult) return;
    const scale = zoom === 'fit' ? fitScale() : zoom;
    setZoom(Math.min(8, Math.max(0.05, scale * f)));
  }

  function updateView() {
    const view = currentView();
    const after = $('afterCanvas');
    const before = $('beforeCanvas');
    const line = $('splitLine');
    before.hidden = view === 'result';
    after.hidden = view === 'original';
    line.hidden = view !== 'compare';
    after.style.clipPath = view === 'compare' ? `inset(0 0 0 ${split * 100}%)` : 'none';
    line.style.left = `${split * 100}%`;
    $('stage').classList.toggle('compare', view === 'compare');
  }

  function bindViewer() {
    for (const r of document.querySelectorAll('input[name="view"]')) r.addEventListener('change', updateView);

    const stage = $('stage');
    let dragging = false;
    const move = (e) => {
      const rect = stage.getBoundingClientRect();
      split = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      updateView();
    };
    stage.addEventListener('pointerdown', (e) => {
      if (currentView() !== 'compare') return;
      dragging = true;
      stage.setPointerCapture(e.pointerId);
      move(e);
    });
    stage.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    stage.addEventListener('pointerup', () => { dragging = false; });
    stage.addEventListener('pointercancel', () => { dragging = false; });

    $('zoomInBtn').addEventListener('click', () => zoomBy(1.25));
    $('zoomOutBtn').addEventListener('click', () => zoomBy(0.8));
    $('zoomFitBtn').addEventListener('click', () => setZoom(zoom === 'fit' ? 1 : 'fit'));
    $('viewer').addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !lastResult) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
    window.addEventListener('resize', () => { if (zoom === 'fit') layoutStage(); });

    const rotate = (d) => {
      const item = items[current];
      if (!item) return;
      item.rotation = (item.rotation + d + 360) % 360;
      zoom = 'fit';
      scheduleProcess(0);
    };
    $('rotLeftBtn').addEventListener('click', () => rotate(-90));
    $('rotRightBtn').addEventListener('click', () => rotate(90));

    const typing = (t) => t && (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'radio' ||
      t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SUMMARY');
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !typing(e.target) && lastResult) {
        e.preventDefault();
        if (!peek) { peek = true; updateView(); }
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
        if (items.length > 1) select((current + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && peek) { peek = false; updateView(); }
    });
    window.addEventListener('blur', () => { if (peek) { peek = false; updateView(); } });
  }

  // ---- Input: picker, drag & drop, paste ------------------------------------

  function bindInput() {
    const input = $('fileInput');
    const drop = $('dropzone');
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    $('emptyAddBtn').addEventListener('click', () => input.click());

    let depth = 0;
    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      depth++;
      document.body.classList.add('dragging');
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) document.body.classList.remove('dragging');
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    document.addEventListener('paste', (e) => {
      const files = [];
      for (const it of (e.clipboardData && e.clipboardData.items) || []) {
        if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
      }
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
  }

  // ---- Export -----------------------------------------------------------------

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function grayToPng(gray, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    HWProcess.grayToRGBA(gray, img.data);
    ctx.putImageData(img, 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  // Result for any item with the current settings (reuses what's on screen).
  async function resultFor(i) {
    const item = items[i];
    if (lastResult && lastResult.item === item && lastResult.key === resultKey(item)) return lastResult;
    return processItem(item, i === current);
  }

  function uniqueNames(ext) {
    const seen = new Map();
    return items.map((it) => {
      const n = seen.get(it.name) || 0;
      seen.set(it.name, n + 1);
      return `${it.name}${n ? `-${n + 1}` : ''}-contrast.${ext}`;
    });
  }

  async function withExport(label, fn) {
    if (!items.length) return;
    setExporting(true);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      setStatus(`${label} failed: ${e.message || e}`);
    } finally {
      setExporting(false);
      hideBusy();
    }
  }

  function bindExport() {
    $('downloadBtn').addEventListener('click', () => withExport('Download', async () => {
      const r = await resultFor(current);
      download(await grayToPng(r.gray, r.w, r.h), uniqueNames('png')[current]);
    }));

    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      $('copyBtn').addEventListener('click', () => withExport('Copy', async () => {
        const r = await resultFor(current);
        const blob = await grayToPng(r.gray, r.w, r.h);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setStatus('Copied result to the clipboard.');
      }));
    } else {
      $('copyBtn').hidden = true;
    }

    $('zipBtn').addEventListener('click', () => withExport('ZIP export', async () => {
      const names = uniqueNames('png');
      const files = [];
      for (let i = 0; i < items.length; i++) {
        showBusy(`Exporting ${i + 1} / ${items.length}…`);
        await yieldToPaint();
        const r = await resultFor(i);
        const png = await grayToPng(r.gray, r.w, r.h);
        files.push({ name: names[i], data: new Uint8Array(await png.arrayBuffer()) });
      }
      download(HWExport.zip(files), 'handwriting-contrast.zip');
      setStatus(`Saved ${files.length} image${files.length === 1 ? '' : 's'} as ZIP.`);
    }));

    $('pdfBtn').addEventListener('click', () => withExport('PDF export', async () => {
      const blob = await HWExport.pdf(items.length, async (i) => {
        showBusy(`Building PDF page ${i + 1} / ${items.length}…`);
        await yieldToPaint();
        const r = await resultFor(i);
        return { width: r.w, height: r.h, gray: r.gray };
      });
      const name = items.length === 1 ? `${items[0].name}-contrast.pdf` : 'handwriting-contrast.pdf';
      download(blob, name);
      setStatus(`Saved ${items.length}-page PDF.`);
    }));
  }

  // ---- UI state -------------------------------------------------------------

  let exporting = false;

  function setExporting(on) {
    exporting = on;
    updateButtons();
  }

  function updateButtons() {
    const has = items.length > 0;
    const ready = has && !!lastResult;
    $('downloadBtn').disabled = !ready || exporting;
    $('copyBtn').disabled = !ready || exporting;
    $('zipBtn').disabled = !ready || exporting;
    $('pdfBtn').disabled = !ready || exporting;
    $('rotLeftBtn').disabled = !has;
    $('rotRightBtn').disabled = !has;
    $('pdfBtn').textContent = items.length > 1 ? 'All as PDF' : 'Save as PDF';
    $('zipBtn').hidden = items.length < 2;
  }

  function showBusy(text) {
    $('busyText').textContent = text;
    $('busy').hidden = false;
  }
  function hideBusy() { $('busy').hidden = true; }
  function setStatus(text) { $('status').textContent = text; }

  // ---- Init -------------------------------------------------------------------

  syncControls();
  bindControls();
  bindViewer();
  bindInput();
  bindExport();
  updateButtons();
})();
