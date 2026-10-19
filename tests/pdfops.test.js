import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFNumber, degrees } from '../public/vendor/pdf-lib.esm.min.js';
import * as ops from '../public/pdfops.js';
import { planEvery, planRanges, parseRanges } from '../public/core.js';

// A document whose pages have distinct widths, so order is visible after transforms.
async function makeDoc(widths, rotations = []) {
  const doc = await PDFDocument.create();
  widths.forEach((w, i) => {
    const p = doc.addPage([w, 800]);
    if (rotations[i]) p.setRotation(degrees(rotations[i]));
  });
  return PDFDocument.load(await doc.save());
}

const widthsOf = async (bytes) => (await PDFDocument.load(bytes)).getPages().map(p => Math.round(p.getWidth()));
const rotsOf = async (bytes) => (await PDFDocument.load(bytes)).getPages().map(p => p.getRotation().angle);

test('merge two files, reorder, rotate, delete', async () => {
  const sources = new Map([['a', await makeDoc([100, 110, 120])], ['b', await makeDoc([200, 210], [90, 0])]]);
  assert.deepEqual(ops.info(sources.get('b')), { pageCount: 2, rotations: [90, 0] });
  // b2, a1, b1 (+90 on a page already at 90 = 180), a3 rotated -90; a2 deleted.
  const pages = [
    { file: 'b', index: 1 }, { file: 'a', index: 0 }, { file: 'b', index: 0, rotate: 90 }, { file: 'a', index: 2, rotate: -90 },
  ];
  const bytes = await ops.save(await ops.assemble(sources, pages));
  assert.deepEqual(await widthsOf(bytes), [210, 100, 200, 120]);
  assert.deepEqual(await rotsOf(bytes), [0, 0, 180, 270]);
});

test('the same page can be used twice', async () => {
  const sources = new Map([['a', await makeDoc([100, 110])]]);
  const bytes = await ops.save(await ops.assemble(sources, [{ file: 'a', index: 1 }, { file: 'a', index: 1 }]));
  assert.deepEqual(await widthsOf(bytes), [110, 110]);
});

test('split every page and by ranges', async () => {
  const sources = new Map([['a', await makeDoc([100, 110, 120, 130, 140])]]);
  const all = [0, 1, 2, 3, 4].map(i => ({ file: 'a', index: i }));
  const singles = planEvery(5, 1);
  assert.equal(singles.length, 5);
  for (const [k, g] of singles.entries()) {
    const bytes = await ops.save(await ops.assemble(sources, g.map(i => all[i])));
    assert.deepEqual(await widthsOf(bytes), [100 + 10 * k]);
  }
  const groups = planRanges(parseRanges('1-2, 4-', 5));
  const out = [];
  for (const g of groups) out.push(await widthsOf(await ops.save(await ops.assemble(sources, g.map(i => all[i])))));
  assert.deepEqual(out, [[100, 110], [130, 140]]);
});

test('encrypted and broken files are reported with a code', async () => {
  await assert.rejects(ops.load(new TextEncoder().encode('not a pdf')), { code: 'unreadable' });
  const doc = await PDFDocument.create();
  doc.addPage();
  let bytes = new TextDecoder('latin1').decode(await doc.save({ useObjectStreams: false }));
  // Fake an /Encrypt entry in the trailer; pdf-lib refuses such files without ignoreEncryption.
  bytes = bytes.replace('trailer\n<<', 'trailer\n<<\n/Encrypt 1 0 R');
  await assert.rejects(ops.load(Uint8Array.from(bytes, c => c.charCodeAt(0))), { code: 'encrypted' });
});

test('recompressImages replaces a raw RGB image (PNG predictor) only when the result is smaller', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const w = 4, h = 3;
  const pixels = Uint8Array.from({ length: w * h * 3 }, (_, i) => (i * 7) % 256);
  // Filter type 1 (Sub) on every row.
  const rows = [];
  for (let r = 0; r < h; r++) {
    rows.push(1);
    for (let i = 0; i < w * 3; i++) rows.push((pixels[r * w * 3 + i] - (i >= 3 ? pixels[r * w * 3 + i - 3] : 0)) & 0xFF);
  }
  const big = new Uint8Array(5000); // padding makes the stream large enough for a "smaller" result
  const stream = doc.context.stream(new Uint8Array([...deflateSync(Uint8Array.from(rows)), ...big]), {
    Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: 8, ColorSpace: 'DeviceRGB',
    Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 3, Columns: w }, Interpolate: true,
  });
  const ref = doc.context.register(stream);
  page.node.setXObject(PDFName.of('Im1'), ref);
  // A JPEG image the encoder cannot shrink.
  const jpegRef = doc.context.register(doc.context.stream(new Uint8Array(50), {
    Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, BitsPerComponent: 8, ColorSpace: 'DeviceGray', Filter: 'DCTDecode',
  }));
  page.node.setXObject(PDFName.of('Im2'), jpegRef);
  // A CMYK image is never touched.
  doc.context.register(doc.context.stream(new Uint8Array(50), {
    Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, BitsPerComponent: 8, ColorSpace: 'DeviceCMYK', Filter: 'DCTDecode',
  }));

  const loaded = await PDFDocument.load(await doc.save());
  assert.equal(ops.findImages(loaded).length, 2);
  const seen = [];
  const stats = await ops.recompressImages(loaded, {
    quality: 0.5, maxPx: 2,
    encoder: async (input, opts) => {
      seen.push(input.kind);
      if (input.kind === 'raw') {
        assert.deepEqual([...input.pixels], [...pixels]);
        assert.equal(opts.maxPx, 2);
        return { bytes: new Uint8Array([0xFF, 0xD8, 1, 2, 0xFF, 0xD9]), width: 2, height: 2 };
      }
      return { bytes: new Uint8Array(80), width: 2, height: 2 }; // bigger than 50: keep the original
    },
  });
  assert.deepEqual(seen.sort(), ['jpeg', 'raw']);
  assert.equal(stats.replaced, 1);
  assert.equal(stats.skipped, 1);
  const again = await PDFDocument.load(await ops.save(loaded));
  const replaced = ops.findImages(again).find(i => i.kind === 'jpeg' && i.width === 2 && i.size === 6);
  assert.ok(replaced, 'raw image became a 2x2 JPEG');
  const d = replaced.stream.dict;
  assert.equal(d.get(PDFName.of('ColorSpace')).asString(), '/DeviceRGB');
  assert.equal(d.get(PDFName.of('DecodeParms')), undefined);
  assert.ok(d.get(PDFName.of('Interpolate')), 'other entries are kept');
  assert.equal(d.get(PDFName.of('Width')).asNumber(), 2);
});

test('imagesToPdf and stripMetadata', async () => {
  // Smallest valid baseline JPEG (1x1 gray), so embedJpg can read its header.
  const jpeg = Uint8Array.from(Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
  const doc = await ops.imagesToPdf([{ jpeg, widthPt: 595, heightPt: 842 }, { jpeg, widthPt: 842, heightPt: 595 }]);
  doc.setTitle('secret');
  ops.stripMetadata(doc);
  const back = await PDFDocument.load(await ops.save(doc));
  assert.deepEqual(back.getPages().map(p => [Math.round(p.getWidth()), Math.round(p.getHeight())]), [[595, 842], [842, 595]]);
  assert.ok(!back.getTitle());
  void PDFNumber;
});
