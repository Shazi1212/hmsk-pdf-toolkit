# PDF Toolkit

Merging two PDFs should not mean uploading your contract or payslip to someone else's server; this toolkit merges, splits, reorders, rotates and compresses PDFs entirely in your browser.

**Use it online:** [hmsk.life/tools/pdf-toolkit](https://hmsk.life/tools/pdf-toolkit/) (runs in your browser, nothing is sent anywhere).

## What it does

- **Merge** any number of PDFs. Sort the files, then drag single pages into any order (pointer events: mouse, pen, and touch via the ⠿ handle). Keyboard: Space selects, Alt+Arrow moves a page.
- **Rotate and delete** pages, one by one or as a selection (Shift+click for a range), with Undo (Ctrl/Cmd+Z).
- **Split** into single pages, every N pages, custom ranges (`1-3, 5, 8-`) or only the selected pages. Several output files are packed into one `.zip` (store-only ZIP writer, no dependency).
- **Compress**, two methods:
  - *Keep text*: JPEG images and uncompressed 8-bit RGB/gray images (FlateDecode, with or without PNG predictors) are re-encoded as JPEG at the chosen quality and downscaled to a maximum size. An image is only replaced when the new one is smaller. CMYK, indexed, masked and other special images are left alone.
  - *Flatten*: every page is rendered with PDF.js at 90 to 150 dpi and stored as a JPEG. Smallest for scans, but text is no longer selectable.
  - It shows the size before and after. If the result is not at least 2 % smaller, it says so and does not download it automatically.
- Large files do not freeze the page: all pdf-lib work runs in a module Web Worker; PDF.js uses its own worker for thumbnails, which are rendered lazily as they scroll into view.
- English and German. Only the language and the last settings are stored (localStorage). No cookies, no analytics, no network requests after the page has loaded.

### What a browser cannot do

Compression here works on the images in a PDF. Fonts, vector graphics and text streams are copied as they are, so a PDF that is mostly text shrinks very little. Server tools based on Ghostscript can sometimes squeeze more (font subsetting, stream rewriting). Bookmarks, form fields and internal links are not carried over when pages are copied. Password-protected PDFs cannot be opened.

## Quick start

No build step, no dependencies. Serve `public/` with any static web server:

```sh
python3 -m http.server 8080 --directory public
# open http://localhost:8080/
```

(ES modules and workers do not load from `file://`, so a server is needed.)

Run the tests (Node.js 20+):

```sh
node --test tests/
```

Tests cover the page-range parser and its errors, split plans, rotation maths, page moves, the ZIP writer (CRC-32 check value, `unzip -t`), the PNG predictor decoder for all five filters, and with pdf-lib in Node: merge + reorder + rotate + delete, split by every page and by ranges, encrypted and broken input, image recompression (raw RGB with predictor replaced, bigger result kept, CMYK skipped) and image-to-PDF.

## Files

| File | What |
|---|---|
| `public/core.js` | pure helpers: ranges, split plans, ZIP, PNG predictor, sizes (no DOM, no PDF library) |
| `public/pdfops.js` | PDF transforms with pdf-lib: assemble pages, recompress images, images to PDF |
| `public/worker.js` | Web Worker running `pdfops.js`; image re-encoding with `OffscreenCanvas` |
| `public/app.js`, `index.html`, `app.css` | the UI, thumbnails with PDF.js, drag and drop |
| `public/i18n.js` | English and German texts |
| `public/config.js` | compression levels, library versions, link base |
| `public/vendor/` | pdf-lib 1.17.1 (MIT) and PDF.js 4.10.38 legacy build (Apache-2.0), with cmaps and standard fonts |

To self-host, set `LINK_BASE` in `public/config.js` if the top-strip links should point somewhere other than hmsk.life. Fonts (Newsreader, Public Sans; SIL Open Font License) are in `public/fonts/`; the shared hmsk.life look is in `public/letterpress.css`.

## Updating the libraries

`npm pack pdf-lib@<v> pdfjs-dist@<v>`, copy `dist/pdf-lib.esm.min.js` and `legacy/build/pdf.min.mjs` / `pdf.worker.min.mjs` (renamed to `.js` so every web server sends a JavaScript MIME type), plus `cmaps/` and `standard_fonts/`, update `LIBS` in `config.js`, run the tests.

## License

MIT, see [LICENSE](LICENSE). Bundled libraries keep their own licenses (`public/vendor/`).
