// Settings and facts shown in the app. Checked 2026-10-19.

export const CHECKED = '2026-10-19';

// Links in the top strip. '' = same host (hosted on hmsk.life). Self-hosted copies point to hmsk.life.
export const LINK_BASE = 'https://hmsk.life';

// Bundled libraries (vendor/), pinned. Update both the files and these numbers together.
export const LIBS = [
  { name: 'pdf-lib', version: '1.17.1', license: 'MIT', url: 'https://github.com/Hopding/pdf-lib' },
  { name: 'PDF.js (pdfjs-dist, legacy build)', version: '4.10.38', license: 'Apache-2.0', url: 'https://github.com/mozilla/pdf.js' },
];

// Compression levels. quality = JPEG quality (0..1); maxPx = longest side of an image after compression;
// dpi = resolution when a page is turned into an image ("flatten" mode).
// 1600 px on the long side of an A4 page (11.7 in) is about 137 dpi.
export const LEVELS = {
  light: { quality: 0.82, maxPx: 2400, dpi: 150 },
  medium: { quality: 0.7, maxPx: 1600, dpi: 120 },
  strong: { quality: 0.55, maxPx: 1100, dpi: 90 },
};

// Above this total the app warns that the browser may run out of memory (all work happens on the device).
export const WARN_BYTES = 300 * 1024 * 1024;

// Thumbnails: rendered width in device pixels.
export const THUMB_PX = 220;
