import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRanges, planEvery, planRanges, groupLabel, normRotation, moveItems, groupByFile,
  formatBytes, savedPercent, baseName, crc32, makeZip, pngUnpredict, toRGBA, fitWithin,
} from '../public/core.js';

test('parseRanges: single pages, ranges, open ends, separators', () => {
  assert.deepEqual(parseRanges('1-3, 5, 8-', 10), [[1, 3], [5, 5], [8, 10]]);
  assert.deepEqual(parseRanges('-2;4', 5), [[1, 2], [4, 4]]);
  assert.deepEqual(parseRanges('2–4', 5), [[2, 4]]); // en dash typed by Word users
  assert.deepEqual(parseRanges(' 3 ', 3), [[3, 3]]);
});

test('parseRanges: errors carry a code', () => {
  assert.throws(() => parseRanges('', 3), { code: 'empty' });
  assert.throws(() => parseRanges('4-2', 5), { code: 'order' });
  assert.throws(() => parseRanges('a', 5), { code: 'syntax' });
  assert.throws(() => parseRanges('1-9', 5), { code: 'bounds' });
  assert.throws(() => parseRanges('0', 5), { code: 'bounds' });
  assert.throws(() => parseRanges('-', 5), { code: 'syntax' });
});

test('split plans', () => {
  assert.deepEqual(planEvery(5, 1), [[0], [1], [2], [3], [4]]);
  assert.deepEqual(planEvery(5, 2), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(planEvery(3, 0), [[0], [1], [2]]);
  assert.deepEqual(planRanges([[1, 3], [5, 5]]), [[0, 1, 2], [4]]);
  assert.equal(groupLabel([0, 1, 2]), '1-3');
  assert.equal(groupLabel([4]), '5');
  assert.equal(groupLabel([0, 2, 3, 6]), '1,3-4,7');
});

test('rotation normalises to quarter turns', () => {
  assert.equal(normRotation(90), 90);
  assert.equal(normRotation(-90), 270);
  assert.equal(normRotation(450), 90);
  assert.equal(normRotation(360), 0);
  assert.equal(normRotation(undefined), 0);
});

test('moveItems and groupByFile', () => {
  assert.deepEqual(moveItems(['a', 'b', 'c', 'd'], [0], 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItems(['a', 'b', 'c', 'd'], [1, 3], 0), ['b', 'd', 'a', 'c']);
  assert.deepEqual(moveItems(['a', 'b', 'c'], [2], 99), ['a', 'b', 'c']);
  const pages = [{ file: 'x', i: 0 }, { file: 'y', i: 0 }, { file: 'x', i: 1 }];
  assert.deepEqual(groupByFile(pages, ['y', 'x']).map(p => p.file + p.i), ['y0', 'x0', 'x1']);
});

test('sizes and names', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024, 'de'), '5,0 MB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
  assert.equal(savedPercent(1000, 400), 60);
  assert.equal(savedPercent(1000, 1100), -10);
  assert.equal(baseName('Vertrag: final?.PDF'), 'Vertrag- final-');
  assert.equal(baseName('  '), 'document');
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('makeZip writes an archive that unzip accepts', (t) => {
  const zip = makeZip([
    { name: 'a.pdf', bytes: new TextEncoder().encode('hello') },
    { name: 'a.pdf', bytes: new TextEncoder().encode('again') },
    { name: 'Übersicht.pdf', bytes: new Uint8Array([1, 2, 3]) },
  ], new Date(2026, 9, 19, 12, 0, 0));
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint16(zip.length - 22 + 10, true), 3);
  let list;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pdfzip-'));
    writeFileSync(join(dir, 't.zip'), zip);
    execFileSync('unzip', ['-tq', join(dir, 't.zip')]);
    list = execFileSync('python3', ['-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', join(dir, 't.zip')]).toString();
  } catch (e) {
    if (e.code === 'ENOENT') return t.skip('unzip not installed');
    throw e;
  }
  assert.match(list, /a-2\.pdf/);
  assert.match(list, /Übersicht\.pdf/);
});

test('pngUnpredict undoes all five PNG filters', () => {
  // 2 columns RGB, rows with filters 0..4. Expected pixels chosen, filtered bytes computed by hand.
  const rows = [
    [10, 20, 30, 40, 50, 60],
    [11, 21, 31, 41, 51, 61],
    [12, 22, 32, 42, 52, 62],
    [13, 23, 33, 43, 53, 63],
    [14, 24, 34, 44, 54, 64],
  ];
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  const enc = [];
  rows.forEach((row, r) => {
    const prev = r ? rows[r - 1] : [0, 0, 0, 0, 0, 0];
    enc.push(r);
    row.forEach((v, i) => {
      const left = i >= 3 ? row[i - 3] : 0, up = prev[i], ul = i >= 3 ? prev[i - 3] : 0;
      const pred = [0, left, up, (left + up) >> 1, paeth(left, up, ul)][r];
      enc.push((v - pred) & 0xFF);
    });
  });
  assert.deepEqual([...pngUnpredict(Uint8Array.from(enc), 2, 3, 8)], rows.flat());
});

test('toRGBA and fitWithin', () => {
  assert.deepEqual([...toRGBA(Uint8Array.from([7, 9]), 1, 2, 1)], [7, 7, 7, 255, 9, 9, 9, 255]);
  assert.deepEqual([...toRGBA(Uint8Array.from([1, 2, 3]), 3, 1, 1)], [1, 2, 3, 255]);
  assert.deepEqual(fitWithin(4000, 2000, 1600), { width: 1600, height: 800, scale: 0.4 });
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600, scale: 1 });
});

