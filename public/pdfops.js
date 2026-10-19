// PDF transforms with pdf-lib: load, assemble pages (merge, reorder, rotate, delete, split), recompress images,
// build a PDF from page images. Runs in the Web Worker (worker.js) and in Node for the tests. No DOM.
import { PDFDocument, PDFName, PDFNumber, PDFArray, PDFRawStream, PDFRef, degrees } from './vendor/pdf-lib.esm.min.js';
import { normRotation, pngUnpredict } from './core.js';

export async function load(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypted/i.test(err && err.message)) {
      const e = new Error('encrypted');
      e.code = 'encrypted';
      throw e;
    }
    const e = new Error('unreadable: ' + (err && err.message));
    e.code = 'unreadable';
    throw e;
  }
}

export function info(doc) {
  return { pageCount: doc.getPageCount(), rotations: doc.getPages().map(p => normRotation(p.getRotation().angle)) };
}

// sources: Map(fileId → PDFDocument). pages: [{ file, index (0-based in the source), rotate (extra degrees) }].
export async function assemble(sources, pages) {
  const out = await PDFDocument.create();
  const byFile = new Map();
  pages.forEach((p, pos) => {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(pos);
  });
  const copied = new Array(pages.length);
  for (const [file, positions] of byFile) {
    const src = sources.get(file);
    if (!src) throw new Error('missing source ' + file);
    const got = await out.copyPages(src, positions.map(pos => pages[pos].index));
    positions.forEach((pos, k) => { copied[pos] = got[k]; });
  }
  pages.forEach((p, pos) => {
    const page = copied[pos];
    const extra = normRotation(p.rotate || 0);
    if (extra) page.setRotation(degrees(normRotation(page.getRotation().angle + extra)));
    out.addPage(page);
  });
  return out;
}

export async function save(doc) {
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

// ---------- image recompression ----------

const N = name => PDFName.of(name);

function num(doc, v) {
  const o = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

function nameOf(doc, v) {
  const o = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return o instanceof PDFName ? o.asString().replace(/^\//, '') : undefined;
}

// Number of colour components, or 0 when the colour space is one we leave alone (CMYK, Indexed, Lab, ...).
function components(doc, cs) {
  const o = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (o instanceof PDFName) {
    const n = nameOf(doc, o);
    return n === 'DeviceRGB' ? 3 : n === 'DeviceGray' ? 1 : 0;
  }
  if (o instanceof PDFArray && nameOf(doc, o.get(0)) === 'ICCBased') {
    const stream = doc.context.lookup(o.get(1));
    const n = stream && stream.dict ? num(doc, stream.dict.get(N('N'))) : undefined;
    return n === 3 || n === 1 ? n : 0;
  }
  return 0;
}

function filters(doc, f) {
  const o = f instanceof PDFRef ? doc.context.lookup(f) : f;
  if (!o) return [];
  if (o instanceof PDFArray) return o.asArray().map(x => nameOf(doc, x));
  return [nameOf(doc, o)];
}

// Inflates a zlib stream. Trailing bytes after the end (common in real PDFs) are tolerated once `expected` bytes are out.
async function inflate(bytes, expected = 0) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (err) {
    if (!expected || total < expected) throw err;
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// Finds the images worth re-encoding. Returns [{ ref, stream, width, height, comps, kind: 'jpeg'|'raw', size, hasMask }].
export function findImages(doc) {
  const found = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (nameOf(doc, d.get(N('Subtype'))) !== 'Image') continue;
    if (d.get(N('ImageMask')) || d.get(N('Decode')) || d.get(N('Mask'))) continue;
    const width = num(doc, d.get(N('Width')));
    const height = num(doc, d.get(N('Height')));
    const bpc = num(doc, d.get(N('BitsPerComponent')));
    const comps = components(doc, d.get(N('ColorSpace')));
    const fl = filters(doc, d.get(N('Filter')));
    if (!width || !height || bpc !== 8 || !comps) continue;
    let kind = null;
    if (fl.length === 1 && fl[0] === 'DCTDecode') kind = 'jpeg';
    else if (fl.length === 1 && fl[0] === 'FlateDecode') kind = 'raw';
    if (!kind) continue;
    found.push({ ref, stream: obj, width, height, comps, kind, size: obj.contents.length, hasMask: !!d.get(N('SMask')) });
  }
  return found;
}

// Pixel bytes (RGB or gray, 8 bit) of a FlateDecode image, undoing a PNG predictor if there is one.
export async function decodeRaw(doc, img) {
  const parms = img.stream.dict.get(N('DecodeParms'));
  const p = parms instanceof PDFRef ? doc.context.lookup(parms) : parms;
  const predictor = p && p.get ? num(doc, p.get(N('Predictor'))) || 1 : 1;
  const rowLen = img.width * img.comps;
  const raw = await inflate(img.stream.contents, (predictor >= 10 ? rowLen + 1 : rowLen) * img.height);
  if (predictor >= 10) {
    const colors = num(doc, p.get(N('Colors'))) || img.comps;
    const columns = num(doc, p.get(N('Columns'))) || img.width;
    return pngUnpredict(raw, columns, colors, 8);
  }
  if (predictor !== 1) throw new Error('predictor ' + predictor);
  return raw;
}

// encoder(input, opts) → { bytes (JPEG), width, height } | null.
// input is { kind: 'jpeg', bytes } or { kind: 'raw', pixels, comps } plus width, height.
// An image is only replaced when the new JPEG is smaller than the old stream.
export async function recompressImages(doc, { quality = 0.7, maxPx = 1600, encoder, onProgress } = {}) {
  const imgs = findImages(doc);
  const stats = { images: imgs.length, replaced: 0, before: 0, after: 0, skipped: 0 };
  let i = 0;
  for (const img of imgs) {
    i++;
    stats.before += img.size;
    let result = null;
    try {
      const input = img.kind === 'jpeg'
        ? { kind: 'jpeg', bytes: img.stream.contents, width: img.width, height: img.height, comps: img.comps }
        : { kind: 'raw', pixels: await decodeRaw(doc, img), width: img.width, height: img.height, comps: img.comps };
      // Images with a soft mask keep their size so mask and image stay aligned.
      result = await encoder(input, { quality, maxPx: img.hasMask ? Math.max(img.width, img.height) : maxPx });
    } catch {
      result = null;
    }
    if (result && result.bytes && result.bytes.length < img.size) {
      const fresh = doc.context.stream(result.bytes, {});
      for (const [k, v] of img.stream.dict.entries()) {
        const key = k.asString();
        if (!['/Filter', '/DecodeParms', '/Length', '/ColorSpace', '/BitsPerComponent', '/Width', '/Height'].includes(key)) fresh.dict.set(k, v);
      }
      fresh.dict.set(N('Type'), N('XObject'));
      fresh.dict.set(N('Subtype'), N('Image'));
      fresh.dict.set(N('Width'), PDFNumber.of(result.width));
      fresh.dict.set(N('Height'), PDFNumber.of(result.height));
      fresh.dict.set(N('BitsPerComponent'), PDFNumber.of(8));
      fresh.dict.set(N('ColorSpace'), N(result.gray ? 'DeviceGray' : 'DeviceRGB'));
      fresh.dict.set(N('Filter'), N('DCTDecode'));
      doc.context.assign(img.ref, fresh);
      stats.replaced++;
      stats.after += result.bytes.length;
    } else {
      stats.skipped++;
      stats.after += img.size;
    }
    if (onProgress) onProgress(i, imgs.length);
  }
  return stats;
}

// Drops document metadata (title, author, XMP) for a smaller, cleaner file.
export function stripMetadata(doc) {
  doc.catalog.delete(N('Metadata'));
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setCreator('');
  doc.setProducer('');
}

// pages: [{ jpeg: Uint8Array, widthPt, heightPt }] → PDFDocument with one full-page image per page.
export async function imagesToPdf(pages) {
  const out = await PDFDocument.create();
  for (const p of pages) {
    const img = await out.embedJpg(p.jpeg);
    const page = out.addPage([p.widthPt, p.heightPt]);
    page.drawImage(img, { x: 0, y: 0, width: p.widthPt, height: p.heightPt });
  }
  return out;
}
