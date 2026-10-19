// Web Worker: all pdf-lib work happens here so large files never freeze the page.
// Messages in: { id, op, ...args }. Out: { id, ok, result } | { id, ok: false, code, message } | { id, progress: [done, total] }.
import * as ops from './pdfops.js';
import { fitWithin, toRGBA } from './core.js';

const sources = new Map(); // fileId → PDFDocument

async function canvasEncoder(input, { quality, maxPx }) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const size = fitWithin(input.width, input.height, maxPx);
  let source;
  if (input.kind === 'jpeg') {
    source = await createImageBitmap(new Blob([input.bytes], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    // A JPEG whose decoded size disagrees with the PDF (e.g. CMYK the browser misreads) is left alone.
    if (source.width !== input.width || source.height !== input.height) { source.close(); return null; }
  } else {
    const data = new ImageData(toRGBA(input.pixels, input.comps, input.width, input.height), input.width, input.height);
    source = await createImageBitmap(data);
  }
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, size.width, size.height);
  source.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: size.width, height: size.height };
}

const handlers = {
  async add({ file, bytes }) {
    const doc = await ops.load(bytes);
    sources.set(file, doc);
    return ops.info(doc);
  },
  async remove({ file }) {
    sources.delete(file);
    return true;
  },
  // outputs: [{ name, pages: [{file, index, rotate}] }] → [{ name, bytes }]
  async build({ outputs, compress, strip }, progress) {
    const files = [];
    let k = 0;
    for (const o of outputs) {
      const doc = await ops.assemble(sources, o.pages);
      let stats = null;
      if (compress) {
        stats = await ops.recompressImages(doc, { ...compress, encoder: canvasEncoder, onProgress: (a, b) => progress([a, b]) });
      }
      if (strip) ops.stripMetadata(doc);
      const bytes = await ops.save(doc);
      files.push({ name: o.name, bytes, stats });
      progress([++k, outputs.length]);
    }
    return files;
  },
  async images({ name, pages, strip }) {
    const doc = await ops.imagesToPdf(pages);
    if (strip) ops.stripMetadata(doc);
    return [{ name, bytes: await ops.save(doc) }];
  },
  async support() {
    return { canvas: typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined', inflate: typeof DecompressionStream !== 'undefined' };
  },
};

self.onmessage = async (ev) => {
  const { id, op, ...args } = ev.data;
  try {
    const result = await handlers[op](args, p => self.postMessage({ id, progress: p }));
    const transfer = Array.isArray(result) ? result.map(f => f.bytes.buffer) : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, code: err.code || 'error', message: String(err && err.message || err) });
  }
};
