// Pure helpers: page ranges, split plans, rotation, ZIP writer, PNG predictor, sizes. No DOM, no PDF library.
// Tested in tests/core.test.js.

// "1-3, 5, 8-" → [[1,3],[5,5],[8,total]] (1-based, inclusive). Throws Error with a code on bad input.
export function parseRanges(text, total) {
  const src = String(text || '').trim();
  if (!src) throw rangeError('empty');
  const out = [];
  for (const raw of src.split(/[,;]+/)) {
    const part = raw.trim().replace(/[–—]/g, '-');
    if (!part) continue;
    let m;
    if ((m = part.match(/^(\d+)$/))) {
      const n = +m[1];
      out.push([n, n]);
    } else if ((m = part.match(/^(\d*)\s*-\s*(\d*)$/)) && (m[1] || m[2])) {
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? +m[2] : total;
      if (a > b) throw rangeError('order', part);
      out.push([a, b]);
    } else {
      throw rangeError('syntax', part);
    }
  }
  if (!out.length) throw rangeError('empty');
  for (const [a, b] of out) {
    if (a < 1 || b > total) throw rangeError('bounds', a < 1 ? String(a) : String(b));
  }
  return out;
}

function rangeError(code, part = '') {
  const e = new Error(`range ${code}${part ? ': ' + part : ''}`);
  e.code = code;
  e.part = part;
  return e;
}

// Split plans return arrays of groups; each group is a list of 0-based page positions.
export function planEvery(total, n = 1) {
  const size = Math.max(1, Math.floor(n));
  const groups = [];
  for (let i = 0; i < total; i += size) {
    groups.push(Array.from({ length: Math.min(size, total - i) }, (_, k) => i + k));
  }
  return groups;
}

export function planRanges(ranges) {
  return ranges.map(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k));
}

// Label for a group of 0-based positions, e.g. [0,1,2] → "1-3", [4] → "5", [0,2] → "1,3".
export function groupLabel(group) {
  const parts = [];
  let i = 0;
  while (i < group.length) {
    let j = i;
    while (j + 1 < group.length && group[j + 1] === group[j] + 1) j++;
    parts.push(i === j ? `${group[i] + 1}` : `${group[i] + 1}-${group[j] + 1}`);
    i = j + 1;
  }
  return parts.join(',');
}

// Rotation in degrees, normalised to 0, 90, 180 or 270.
export function normRotation(deg) {
  const r = Math.round((Number(deg) || 0) / 90) * 90;
  return ((r % 360) + 360) % 360;
}

// Move items at the given indexes (sorted or not) so they start at index `to` in the list without them.
export function moveItems(list, indexes, to) {
  const set = new Set(indexes);
  const moving = list.filter((_, i) => set.has(i));
  const rest = list.filter((_, i) => !set.has(i));
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

// Stable sort of pages so all pages of a file stay together in the given file order.
export function groupByFile(pages, fileOrder) {
  const rank = new Map(fileOrder.map((id, i) => [id, i]));
  return pages.map((p, i) => [p, i]).sort((x, y) => (rank.get(x[0].file) - rank.get(y[0].file)) || (x[1] - y[1])).map(x => x[0]);
}

export function formatBytes(n, locale = 'en') {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const digits = u === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[u]}`;
}

// Saving in percent, negative when the result is bigger.
export function savedPercent(before, after) {
  if (!before) return 0;
  return Math.round((1 - after / before) * 1000) / 10;
}

// File name without extension and without characters that break downloads.
export function baseName(name) {
  const b = String(name || 'document').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim();
  return b || 'document';
}

export function pdfName(name) {
  return baseName(name) + '.pdf';
}

// ---------- CRC32 + ZIP (store only; PDFs are already compressed) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, bytes: Uint8Array }] → Uint8Array of a ZIP archive. Names are stored as UTF-8.
export function makeZip(files, date = new Date()) {
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const used = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    let name = f.name;
    for (let k = 2; used.has(name); k++) name = f.name.replace(/(\.[^.]*)?$/, `-${k}$1`);
    used.add(name);
    const nameBytes = enc.encode(name);
    const data = f.bytes;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, p); p += part.length; }
  return out;
}

// ---------- PNG predictors (FlateDecode images with /Predictor >= 10) ----------

// data: inflated bytes with one filter-type byte per row. Returns the unfiltered pixel bytes.
export function pngUnpredict(data, columns, colors = 1, bpc = 8) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      switch (type) {
        case 0: break;
        case 1: v += left; break;
        case 2: v += up; break;
        case 3: v += (left + up) >> 1; break;
        case 4: {
          const pa = Math.abs(up - upLeft), pb = Math.abs(left - upLeft), pc = Math.abs(left + up - 2 * upLeft);
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default: throw new Error('png filter ' + type);
      }
      row[i] = v & 0xFF;
    }
    prev = row;
  }
  return out;
}

// RGB (3) or gray (1) 8-bit pixels → RGBA for ImageData.
export function toRGBA(pixels, comps, width, height) {
  const n = width * height;
  if (pixels.length < n * comps) throw new Error('short image data');
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += comps) {
    const o = i * 4;
    if (comps === 1) { out[o] = out[o + 1] = out[o + 2] = pixels[j]; }
    else { out[o] = pixels[j]; out[o + 1] = pixels[j + 1]; out[o + 2] = pixels[j + 2]; }
    out[o + 3] = 255;
  }
  return out;
}

// Target size so the longer side is at most maxPx; never upscales.
export function fitWithin(width, height, maxPx) {
  const s = Math.min(1, maxPx / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)), scale: s };
}
