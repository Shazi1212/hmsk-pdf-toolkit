// UI: files, page grid (thumbnails with PDF.js, drag to reorder), merge / split / compress via the worker.
// Files stay in memory in this tab only. localStorage keeps the language and the last settings.
import * as pdfjs from './vendor/pdfjs/pdf.min.js';
import { TEXT } from './i18n.js';
import { CHECKED, LINK_BASE, LIBS, LEVELS, WARN_BYTES, THUMB_PX } from './config.js';
import {
  parseRanges, planEvery, planRanges, groupLabel, normRotation, moveItems, groupByFile,
  formatBytes, savedPercent, baseName, pdfName, makeZip,
} from './core.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
const PDFJS_OPTS = {
  cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
  enableXfa: false,
};

const STORE = 'pdf-toolkit';
const COLORS = ['#00FF9C', '#6FBF92', '#A9DDBF', '#2C8A5C', '#D5F0DF', '#4C6355'];
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- state ----------
let lang = pickLang();
const T = () => TEXT[lang];
const files = []; // { id, name, size, pageCount, rotations, pdf (PDF.js doc), color }
let pages = []; // { key, file, index, rotate }
let selected = new Set(); // page keys
let anchor = null; // last clicked key, for shift ranges
const undoStack = [];
let seq = 0;
let busy = false;
const prefs = loadPrefs();

function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'de' || q === 'en') return q;
  try { const s = localStorage.getItem(STORE + '-lang'); if (s === 'de' || s === 'en') return s; } catch {}
  return (navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en';
}
function loadPrefs() {
  const d = { tab: 'merge', split: 'every', n: 2, level: 'medium', mode: 'images', strip: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return d; }
}
function savePrefs() {
  try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch {}
}
const fileById = id => files.find(f => f.id === id);
// Files that still have pages. Removing a file only removes its pages, so Undo can bring it back.
const shownFiles = () => files.filter(f => pages.some(p => p.file === f.id));

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let reqId = 0;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  if (data.progress) { p.onProgress && p.onProgress(data.progress); return; }
  pending.delete(data.id);
  if (data.ok) p.resolve(data.result);
  else { const e = new Error(data.message); e.code = data.code; p.reject(e); }
};
function call(op, args = {}, transfer = [], onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, op, ...args }, transfer);
  });
}

// ---------- texts ----------
function applyTexts() {
  const t = T();
  document.documentElement.lang = lang;
  document.title = t.docTitle;
  for (const el of $$('[data-t]')) {
    const v = t[el.dataset.t];
    if (typeof v === 'string') el.textContent = v;
  }
  for (const el of $$('[data-tp]')) el.placeholder = t[el.dataset.tp];
  $('#langBtn').setAttribute('aria-label', t.langSwitchLabel);
  const de = lang === 'de';
  $('#lnkHome').href = $('#lnkHome2').href = LINK_BASE + (de ? '/de/tools/pdf-toolkit/' : '/tools/pdf-toolkit/');
  $('#lnkImprint').href = LINK_BASE + (de ? '/impressum/' : '/imprint/');
  $('#lnkPrivacy').href = LINK_BASE + (de ? '/datenschutz/' : '/privacy/');
  $('#lnkNotify').href = LINK_BASE + (de ? '/de/?topic=pdf-toolkit#contact' : '/?topic=pdf-toolkit#contact');
  $('#howList').innerHTML = t.how.map(s => `<li>${esc(s)}</li>`).join('');
  $('#libs').innerHTML = LIBS.map(l => `<li><a href="${l.url}" target="_blank" rel="noopener">${esc(l.name)}</a> ${l.version} (${l.license})</li>`).join('');
  $('#asOf').textContent = t.asOf(CHECKED);
  renderAll();
}

// ---------- messages and progress ----------
function message(text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.setAttribute('role', 'alert');
  div.innerHTML = `<p>${esc(text)}</p><button type="button" aria-label="OK">×</button>`;
  div.querySelector('button').onclick = () => div.remove();
  $('#msgs').append(div);
}
function progress(text, frac) {
  const box = $('#progress');
  box.hidden = text == null;
  if (text == null) return;
  $('#progressText').textContent = text;
  box.classList.toggle('indet', frac == null);
  $('#progressBar').style.width = frac == null ? '' : Math.round(frac * 100) + '%';
}
function setBusy(b) {
  busy = b;
  for (const el of $$('.panel .btn--amber, .toolbar .btn, .file button')) el.disabled = b || (el.id === 'undoBtn' && !undoStack.length);
  document.body.setAttribute('aria-busy', String(b));
}
const tick = () => new Promise(r => setTimeout(r, 0));

// ---------- adding files ----------
async function addFiles(list) {
  const pdfs = [...list];
  if (!pdfs.length || busy) return;
  setBusy(true);
  if (pages.length) snapshot();
  try {
    for (const f of pdfs) {
      progress(T().reading(f.name), null);
      const buf = await f.arrayBuffer();
      const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
      if (!head.includes('%PDF')) { message(T().errNotPdf(f.name)); continue; }
      const id = 'f' + (++seq);
      const forPdfjs = new Uint8Array(buf.slice(0));
      let info;
      try {
        info = await call('add', { file: id, bytes: buf }, [buf]);
      } catch (err) {
        message(err.code === 'encrypted' ? T().errEncrypted(f.name) : T().errUnreadable(f.name));
        continue;
      }
      let pdf = null;
      try {
        const task = pdfjs.getDocument({ ...PDFJS_OPTS, data: forPdfjs });
        task.onPassword = () => task.destroy();
        pdf = await task.promise;
      } catch { /* thumbnails unavailable; the file still works */ }
      const file = { id, name: f.name, size: f.size, pageCount: info.pageCount, rotations: info.rotations, pdf, color: COLORS[files.length % COLORS.length] };
      files.push(file);
      for (let i = 0; i < info.pageCount; i++) pages.push({ key: 'p' + (++seq), file: id, index: i, rotate: 0 });
      if (!$('#nameMerge').value) $('#nameMerge').value = baseName(f.name) + (pdfs.length > 1 ? '-merged' : '');
    }
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > WARN_BYTES) message(T().warnBig);
  } finally {
    progress(null);
    setBusy(false);
    renderAll();
  }
}

// ---------- history ----------
function snapshot() {
  undoStack.push({ pages: pages.map(p => ({ ...p })), order: files.map(f => f.id) });
  if (undoStack.length > 50) undoStack.shift();
  $('#undoBtn').disabled = false;
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  pages = s.pages;
  files.sort((a, b) => s.order.indexOf(a.id) - s.order.indexOf(b.id));
  selected = new Set([...selected].filter(k => pages.some(p => p.key === k)));
  renderAll();
}

// ---------- rendering ----------
const thumbs = new Map(); // "file:index" → canvas (rendered at the page's own rotation)
const rendering = new Map();
const queue = [];
let active = 0;
const io = new IntersectionObserver(entries => {
  for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); request(en.target.dataset.key); }
}, { rootMargin: '400px' });

function request(key) {
  const p = pages.find(x => x.key === key);
  if (!p) return;
  const id = p.file + ':' + p.index;
  if (thumbs.has(id)) { drawCard(key); return; }
  if (!rendering.has(id)) { rendering.set(id, [key]); queue.push(p); pump(); }
  else rendering.get(id).push(key);
}
async function pump() {
  while (active < 2 && queue.length) {
    const p = queue.shift();
    active++;
    renderThumb(p).finally(() => { active--; pump(); });
  }
}
async function renderThumb(p) {
  const id = p.file + ':' + p.index;
  const f = fileById(p.file);
  let canvas = null;
  try {
    if (f && f.pdf) {
      const page = await f.pdf.getPage(p.index + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: THUMB_PX / Math.max(vp1.width, vp1.height) * 1.1 });
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#fff' }).promise;
      page.cleanup();
    }
  } catch { canvas = null; }
  thumbs.set(id, canvas || blank());
  for (const key of rendering.get(id) || []) drawCard(key);
  rendering.delete(id);
}
function blank() {
  const c = document.createElement('canvas');
  c.width = 150; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 150, 200);
  g.fillStyle = '#8FA898'; g.font = '14px monospace'; g.textAlign = 'center'; g.fillText('PDF', 75, 105);
  return c;
}
// Draws the cached thumbnail into the card's canvas with the extra rotation applied.
function drawCard(key) {
  const li = document.querySelector(`.pg[data-key="${key}"]`);
  const p = pages.find(x => x.key === key);
  if (!li || !p) return;
  const src = thumbs.get(p.file + ':' + p.index);
  if (!src) return;
  const r = normRotation(p.rotate);
  const side = r === 90 || r === 270;
  const c = li.querySelector('canvas') || document.createElement('canvas');
  c.width = side ? src.height : src.width;
  c.height = side ? src.width : src.height;
  const g = c.getContext('2d');
  g.save();
  g.translate(c.width / 2, c.height / 2);
  g.rotate(r * Math.PI / 180);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  g.restore();
  const box = li.querySelector('.pg__thumb');
  box.classList.remove('loading');
  if (!c.parentNode) box.append(c);
}

function renderAll() {
  const t = T();
  const shown = shownFiles();
  const has = files.length > 0;
  $('#work').hidden = !has;
  document.body.classList.toggle('has-files', has);
  $('#drop').classList.toggle('compact', has);
  // file chips
  $('#files').innerHTML = shown.map((f, i) => `
    <div class="file" data-file="${f.id}">
      <i style="background:${f.color}"></i><b title="${esc(f.name)}">${esc(f.name)}</b>
      <small>${esc(t.pagesN(f.pageCount))} · ${formatBytes(f.size, lang)}</small>
      <button type="button" data-act="up" aria-label="${esc(t.moveUp)}" title="${esc(t.moveUp)}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" data-act="down" aria-label="${esc(t.moveDown)}" title="${esc(t.moveDown)}" ${i === shown.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" data-act="remove" aria-label="${esc(t.removeFile)}" title="${esc(t.removeFile)}">×</button>
    </div>`).join('');
  // grid: reuse existing cards so thumbnails are not redrawn
  const grid = $('#grid');
  const old = new Map($$('.pg').map(li => [li.dataset.key, li]));
  const frag = document.createDocumentFragment();
  pages.forEach((p, i) => {
    let li = old.get(p.key);
    const f = fileById(p.file);
    if (!li) {
      li = document.createElement('li');
      li.className = 'pg';
      li.dataset.key = p.key;
      li.tabIndex = 0;
      li.setAttribute('role', 'option');
      li.innerHTML = `<div class="pg__thumb loading"></div>
        <span class="pg__grip" aria-hidden="true">⠿</span><span class="pg__chk" aria-hidden="true"></span>
        <div class="pg__acts"><button type="button" data-act="rotl">⟲</button><button type="button" data-act="rotr">⟳</button><button type="button" data-act="del">×</button></div>
        <div class="pg__meta"><span class="pg__n"></span><span class="pg__src"><i></i><span></span></span></div>`;
      io.observe(li);
    } else {
      old.delete(p.key);
    }
    li.querySelector('.pg__n').textContent = i + 1;
    li.querySelector('.pg__src i').style.background = f.color;
    li.querySelector('.pg__src span').textContent = `p${p.index + 1}`;
    li.setAttribute('aria-selected', String(selected.has(p.key)));
    li.setAttribute('aria-label', t.pageOf(i + 1, f.name, p.index + 1));
    const [a, b, c] = li.querySelectorAll('.pg__acts button');
    a.title = a.ariaLabel = t.rotLShort; b.title = b.ariaLabel = t.rotRShort; c.title = c.ariaLabel = t.delPage;
    frag.append(li);
    if (li.querySelector('canvas')) drawCard(p.key);
  });
  for (const li of old.values()) { io.unobserve(li); li.remove(); }
  grid.append(frag);
  grid.setAttribute('role', 'listbox');
  grid.setAttribute('aria-multiselectable', 'true');
  $('#statusLine').textContent = t.status(pages.length, selected.size);
  $('#selBtn').textContent = selected.size && selected.size === pages.length ? t.selectNone : t.selectAll;
  $('#undoBtn').disabled = busy || !undoStack.length;
  updateSplitPreview();
}

// ---------- page actions ----------
function rotate(keys, deg) {
  if (!keys.length) return message(T().errNoSel);
  snapshot();
  for (const p of pages) if (keys.includes(p.key)) p.rotate = normRotation(p.rotate + deg);
  for (const k of keys) drawCard(k);
  renderAll();
}
function remove(keys) {
  if (!keys.length) return message(T().errNoSel);
  snapshot();
  pages = pages.filter(p => !keys.includes(p.key));
  for (const k of keys) selected.delete(k);
  renderAll();
}
function select(key, ev) {
  if (ev && ev.shiftKey && anchor && pages.some(p => p.key === anchor)) {
    const a = pages.findIndex(p => p.key === anchor), b = pages.findIndex(p => p.key === key);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(pages[i].key);
  } else if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  anchor = key;
  renderAll();
}
function moveKeys(keys, to) {
  const idx = keys.map(k => pages.findIndex(p => p.key === k)).filter(i => i >= 0).sort((a, b) => a - b);
  snapshot();
  pages = moveItems(pages, idx, to);
  renderAll();
}

// ---------- drag to reorder (pointer events; works with mouse, pen and touch via the grip) ----------
let drag = null;
let justDragged = false;
function onPointerDown(ev) {
  const li = ev.target.closest('.pg');
  if (!li || busy || ev.button > 0 || ev.target.closest('.pg__acts')) return;
  const onGrip = !!ev.target.closest('.pg__grip');
  if (ev.pointerType === 'touch' && !onGrip) return; // let the page scroll
  drag = { li, key: li.dataset.key, x: ev.clientX, y: ev.clientY, id: ev.pointerId, started: false };
}
function onPointerMove(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  if (!drag.started) {
    if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 6) return;
    drag.started = true;
    drag.keys = selected.has(drag.key) ? pages.filter(p => selected.has(p.key)).map(p => p.key) : [drag.key];
    for (const k of drag.keys) document.querySelector(`.pg[data-key="${k}"]`)?.classList.add('drag-src');
    const g = $('#ghost');
    const src = drag.li.querySelector('canvas');
    g.innerHTML = '';
    if (src) { const c = document.createElement('canvas'); c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0); g.append(c); }
    if (drag.keys.length > 1) g.insertAdjacentHTML('beforeend', `<b>${drag.keys.length}</b>`);
    g.hidden = false;
    document.body.classList.add('dragging-page');
    try { drag.li.setPointerCapture(ev.pointerId); } catch {}
  }
  ev.preventDefault();
  const g = $('#ghost');
  g.style.left = ev.clientX + 'px';
  g.style.top = ev.clientY + 'px';
  // find the card under the pointer and move the dragged card before or after it
  g.hidden = true;
  const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pg');
  g.hidden = false;
  if (under && under !== drag.li) {
    const r = under.getBoundingClientRect();
    const after = ev.clientX > r.left + r.width / 2;
    under.parentNode.insertBefore(drag.li, after ? under.nextSibling : under);
  }
  autoScroll(ev.clientY);
}
function onPointerUp(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.started) return;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  $('#ghost').hidden = true;
  document.body.classList.remove('dragging-page');
  $$('.drag-src').forEach(el => el.classList.remove('drag-src'));
  // position = number of non-moving cards before the dropped card in the DOM
  const domKeys = $$('.pg').map(li => li.dataset.key);
  const moving = new Set(d.keys);
  let to = 0;
  for (const k of domKeys) { if (k === d.key) break; if (!moving.has(k)) to++; }
  moveKeys(d.keys, to);
}
function autoScroll(y) {
  const edge = 60;
  if (y < edge) window.scrollBy(0, -12);
  else if (y > innerHeight - edge) window.scrollBy(0, 12);
}

// ---------- outputs ----------
const spec = list => list.map(p => ({ file: p.file, index: p.index, rotate: p.rotate }));
function download(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function finished() {
  progress(null);
  const done = document.createElement('p');
  done.className = 'done';
  done.textContent = T().done;
  $('#progress').after(done);
  setTimeout(() => done.remove(), 5000);
  $('#nudge').hidden = false;
}
async function run(fn) {
  if (busy) return;
  if (!pages.length) return message(T().errNoPages);
  setBusy(true);
  try { await fn(); }
  catch (err) { console.error(err); message(T().errBuild); progress(null); }
  finally { setBusy(false); }
}
const outName = () => baseName($('#nameMerge').value || (files[0] && files[0].name));

function mergeOut() {
  return run(async () => {
    progress(T().working, null);
    const [out] = await call('build', { outputs: [{ name: pdfName(outName()), pages: spec(pages) }] }, [],
      ([a, b]) => progress(T().building(a, b), a / b));
    download(out.bytes, out.name);
    finished();
  });
}

function splitGroups() {
  const mode = prefs.split;
  if (mode === 'every') return planEvery(pages.length, 1);
  if (mode === 'n') return planEvery(pages.length, Math.max(1, +$('#splitN').value || 1));
  if (mode === 'ranges') return planRanges(parseRanges($('#ranges').value, pages.length));
  const idx = pages.map((p, i) => (selected.has(p.key) ? i : -1)).filter(i => i >= 0);
  if (!idx.length) { const e = new Error('sel'); e.code = 'sel'; throw e; }
  return [idx];
}
function splitError(err) {
  const t = T();
  if (err.code === 'sel') return t.errNoSel;
  const m = t.errRange[err.code];
  return typeof m === 'function' ? m(err.part) : m || t.errBuild;
}
function updateSplitPreview() {
  const el = $('#splitPreview');
  if (!el) return;
  $('#ranges').removeAttribute('aria-invalid');
  if (!pages.length) { el.textContent = ''; return; }
  try {
    const g = splitGroups();
    el.className = 'preview';
    el.textContent = T().splitPreview(g.length) + (g.length <= 12 ? ': ' + g.map(groupLabel).join(' | ') : '');
  } catch (err) {
    if (prefs.split === 'ranges' && !$('#ranges').value.trim()) { el.textContent = ''; return; }
    el.className = 'preview err';
    el.textContent = splitError(err);
    if (prefs.split === 'ranges') $('#ranges').setAttribute('aria-invalid', 'true');
  }
}
function splitOut() {
  let groups;
  try { groups = splitGroups(); } catch (err) { return message(splitError(err)); }
  return run(async () => {
    const base = outName();
    const outputs = groups.map(g => ({ name: `${base}-p${groupLabel(g)}.pdf`, pages: spec(g.map(i => pages[i])) }));
    progress(T().working, null);
    const res = await call('build', { outputs }, [], ([a, b]) => progress(T().building(a, b), a / b));
    if (res.length === 1) download(res[0].bytes, res[0].name);
    else download(makeZip(res.map(r => ({ name: r.name, bytes: r.bytes }))), `${base}-split.zip`, 'application/zip');
    finished();
  });
}

let lastCompressed = null;
function compressOut() {
  return run(async () => {
    const t = T();
    const level = LEVELS[prefs.level] || LEVELS.medium;
    const used = new Set(pages.map(p => p.file));
    const before = files.filter(f => used.has(f.id)).reduce((s, f) => s + f.size, 0);
    let out;
    let stats = null;
    if (prefs.mode === 'flatten') {
      out = await flatten(level);
    } else {
      const support = await call('support');
      if (!support.canvas) { message(t.errNoCanvas); progress(null); return; }
      progress(t.working, null);
      [out] = await call('build', {
        outputs: [{ name: pdfName(outName() + '-compressed'), pages: spec(pages) }],
        compress: { quality: level.quality, maxPx: level.maxPx }, strip: prefs.strip,
      }, [], ([a, b]) => progress(t.images(a, b), a / b));
      stats = out.stats;
    }
    progress(null);
    lastCompressed = out;
    const after = out.bytes.length;
    const pct = savedPercent(before, after);
    const box = $('#compressResult');
    box.hidden = false;
    const smaller = after < before * 0.98; // under 2 % is not worth a lossy copy
    box.innerHTML = `
      ${smaller ? `<p class="big">${esc(t.resSaved(pct.toLocaleString(lang === 'de' ? 'de-DE' : 'en-GB')))}</p>` : ''}
      <dl><dt>${esc(t.resBefore)}</dt><dd>${formatBytes(before, lang)}</dd><dt>${esc(t.resAfter)}</dt><dd>${formatBytes(after, lang)}</dd></dl>
      ${stats ? `<p class="hint">${esc(stats.images ? t.resImages(stats.replaced, stats.images) : t.resNoImages)}</p>` : ''}
      ${smaller ? '' : `<p>${esc(t.resWorse)}</p>`}
      <button type="button" class="btn ${smaller ? 'btn--amber' : 'btn--ghost'} wide" id="dlCompressed">${esc(smaller ? t.downloadResult : t.downloadAnyway)}</button>`;
    $('#dlCompressed').onclick = () => { download(lastCompressed.bytes, lastCompressed.name); finished(); };
    if (smaller) { download(out.bytes, out.name); finished(); }
  });
}

// Renders every page to a JPEG on the main thread (yielding between pages) and lets the worker assemble them.
async function flatten(level) {
  const t = T();
  const jpegs = [];
  const scale = level.dpi / 72;
  for (let i = 0; i < pages.length; i++) {
    progress(t.rendering(i + 1, pages.length), i / pages.length);
    await tick();
    const p = pages[i];
    const f = fileById(p.file);
    if (!f.pdf) throw new Error('no renderer');
    const page = await f.pdf.getPage(p.index + 1);
    const rotation = normRotation(page.rotate + p.rotate);
    const vp1 = page.getViewport({ scale: 1, rotation });
    const s = Math.min(scale, 6000 / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale: s, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#fff' }).promise;
    page.cleanup();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', level.quality));
    canvas.width = canvas.height = 0;
    jpegs.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), widthPt: vp1.width, heightPt: vp1.height });
  }
  progress(t.working, null);
  const [out] = await call('images', { name: pdfName(outName() + '-compressed'), pages: jpegs, strip: prefs.strip }, jpegs.map(j => j.jpeg.buffer));
  return out;
}

// ---------- tabs and settings ----------
function showTab(name) {
  prefs.tab = name; savePrefs();
  for (const b of $$('[role=tab]')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of $$('[role=tabpanel]')) p.hidden = p.id !== 'p-' + name;
}
function bindSettings() {
  for (const r of $$('input[name=split]')) { r.checked = r.value === prefs.split; r.onchange = () => { prefs.split = r.value; savePrefs(); updateSplitPreview(); }; }
  for (const r of $$('input[name=level]')) { r.checked = r.value === prefs.level; r.onchange = () => { prefs.level = r.value; savePrefs(); }; }
  for (const r of $$('input[name=mode]')) { r.checked = r.value === prefs.mode; r.onchange = () => { prefs.mode = r.value; savePrefs(); }; }
  $('#strip').checked = !!prefs.strip;
  $('#strip').onchange = e => { prefs.strip = e.target.checked; savePrefs(); };
  $('#splitN').value = prefs.n;
  $('#splitN').oninput = e => { prefs.n = e.target.value; prefs.split = 'n'; $('input[name=split][value=n]').checked = true; savePrefs(); updateSplitPreview(); };
  $('#ranges').oninput = () => { prefs.split = 'ranges'; $('input[name=split][value=ranges]').checked = true; savePrefs(); updateSplitPreview(); };
  $('#ranges').onfocus = () => { prefs.split = 'ranges'; $('input[name=split][value=ranges]').checked = true; updateSplitPreview(); };
}

// ---------- events ----------
function bind() {
  const input = $('#fileInput');
  $('#chooseBtn').onclick = $('#addBtn').onclick = () => input.click();
  input.onchange = () => { addFiles(input.files); input.value = ''; };
  // drag files from the desktop anywhere onto the page
  let depth = 0;
  const hasFiles = ev => [...(ev.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); depth++; document.body.classList.add('dragging-file'); });
  addEventListener('dragover', ev => { if (hasFiles(ev)) ev.preventDefault(); });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging-file'); });
  addEventListener('drop', ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault(); depth = 0; document.body.classList.remove('dragging-file');
    addFiles([...ev.dataTransfer.files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name) || !f.type));
  });

  $('#files').onclick = ev => {
    const b = ev.target.closest('button');
    if (!b || busy) return;
    const id = b.closest('.file').dataset.file;
    snapshot();
    if (b.dataset.act === 'remove') {
      pages = pages.filter(p => p.file !== id);
      selected = new Set([...selected].filter(k => pages.some(p => p.key === k)));
    } else {
      const shown = shownFiles();
      const i = shown.findIndex(f => f.id === id);
      const j = b.dataset.act === 'up' ? i - 1 : i + 1;
      [shown[i], shown[j]] = [shown[j], shown[i]];
      const order = shown.map(f => f.id);
      files.sort((a, c) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(c.id) + 1 || 1e9));
      pages = groupByFile(pages, order);
    }
    renderAll();
  };

  const grid = $('#grid');
  grid.addEventListener('pointerdown', onPointerDown);
  addEventListener('pointermove', onPointerMove, { passive: false });
  addEventListener('pointerup', onPointerUp);
  addEventListener('pointercancel', ev => { if (drag && drag.started) onPointerUp(ev); drag = null; });
  grid.addEventListener('click', ev => {
    const li = ev.target.closest('.pg');
    if (!li || busy || justDragged) return;
    const b = ev.target.closest('.pg__acts button');
    if (!b) { select(li.dataset.key, ev); return; }
    const key = li.dataset.key;
    if (b.dataset.act === 'rotl') rotate([key], -90);
    else if (b.dataset.act === 'rotr') rotate([key], 90);
    else remove([key]);
  });
  grid.addEventListener('keydown', ev => {
    const li = ev.target.closest('.pg');
    if (!li || ev.target !== li || busy) return;
    const key = li.dataset.key;
    const i = pages.findIndex(p => p.key === key);
    const cols = Math.max(1, Math.round(grid.clientWidth / li.offsetWidth));
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[ev.key];
    if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); select(key, ev); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); remove([key]); focusAt(Math.min(i, pages.length - 1)); }
    else if (step && ev.altKey) {
      ev.preventDefault();
      const to = Math.max(0, Math.min(pages.length - 1, i + step));
      moveKeys([key], to);
      focusAt(to);
    } else if (step) { ev.preventDefault(); focusAt(Math.max(0, Math.min(pages.length - 1, i + step))); }
  });

  $('#selBtn').onclick = () => {
    selected = selected.size === pages.length ? new Set() : new Set(pages.map(p => p.key));
    renderAll();
  };
  $('#rotLBtn').onclick = () => rotate([...selected], -90);
  $('#rotRBtn').onclick = () => rotate([...selected], 90);
  $('#delBtn').onclick = () => remove([...selected]);
  $('#undoBtn').onclick = undo;
  $('#clearBtn').onclick = async () => {
    for (const f of files) { call('remove', { file: f.id }); f.pdf && f.pdf.destroy(); }
    files.length = 0; pages = []; selected.clear(); undoStack.length = 0; thumbs.clear();
    $('#nameMerge').value = '';
    $('#compressResult').hidden = true;
    $('#msgs').innerHTML = '';
    renderAll();
  };
  addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.target.closest('input') && !busy) { ev.preventDefault(); undo(); }
  });

  for (const b of $$('[role=tab]')) b.onclick = () => showTab(b.dataset.tab);
  $('#tabs').addEventListener('keydown', ev => {
    const tabs = $$('[role=tab]');
    const i = tabs.indexOf(document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    const n = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    showTab(n.dataset.tab); n.focus();
  });
  $('#mergeBtn').onclick = mergeOut;
  $('#splitBtn').onclick = splitOut;
  $('#compressBtn').onclick = compressOut;

  $('#langBtn').onclick = () => {
    lang = lang === 'de' ? 'en' : 'de';
    try { localStorage.setItem(STORE + '-lang', lang); } catch {}
    const u = new URL(location.href); u.searchParams.set('lang', lang);
    window.history.replaceState(null, '', u);
    applyTexts();
  };
}
function focusAt(i) {
  $$('.pg')[i]?.focus();
}

bind();
bindSettings();
showTab(prefs.tab);
applyTexts();
