// Sanity checks for the processing pipeline. Run with: node test/processing.test.js
'use strict';
const assert = require('assert');
const P = require('../js/processing.js');

// Deterministic PRNG so the test is stable.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => rand() + rand() + rand() - 1.5;

// Synthetic photo: paper with a strong lighting gradient + dark corner shadow,
// noise, faint pencil strokes and dark pen strokes. Returns RGBA + truth masks.
function makePage(w, h, color) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const faint = new Uint8Array(w * h), dark = new Uint8Array(w * h), ruled = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const light = 1 - 0.45 * (x / w) * (y / h) - 0.35 * Math.exp(-((x - w * 0.2) ** 2 + (y - h * 0.8) ** 2) / (2 * (w * 0.12) ** 2));
      let r = 236, g = 230, b = 218;
      const band = Math.floor(y / 40);
      if (y % 40 === 0 && color) { r = 180; g = 200; b = 222; ruled[i] = 1; }
      // 4px-wide wavy strokes across each band
      const cy = band * 40 + 20 + 6 * Math.sin(x / 9 + band);
      if (Math.abs(y - cy) < 2 && x > 20 && x < w - 20) {
        if (band % 2) { r = 150; g = 148; b = 145; faint[i] = 1; } else { r = 30; g = 30; b = 60; dark[i] = 1; }
      }
      const n = gauss() * 10;
      rgba[i * 4] = r * light + n;
      rgba[i * 4 + 1] = g * light + n;
      rgba[i * 4 + 2] = b * light + n;
      rgba[i * 4 + 3] = 255;
    }
  }
  return { rgba, faint, dark, ruled };
}

// Recall on `truth`; false-positive rate on paper that isn't within 1px of
// any mark (stroke edges are legitimately ambiguous).
function score(gray, truth, others) {
  const marks = [truth, ...others];
  const nearMark = (i) => {
    const x = i % W, y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H && marks.some((m) => m[yy * W + xx])) return true;
    }
    return false;
  };
  let hit = 0, tot = 0, fp = 0, bg = 0;
  for (let i = 0; i < gray.length; i++) {
    if (truth[i]) { tot++; if (gray[i] < 128) hit++; } else if (!nearMark(i)) { bg++; if (gray[i] < 128) fp++; }
  }
  return { recall: hit / tot, fpRate: fp / bg };
}

const W = 600, H = 400;
const opts = { backgroundRadius: 24, smoothing: 1 };
const renderOpts = { sensitivity: 60, seedRatio: 2, speckArea: 4, bolden: 0, mode: 'binary' };

{
  const page = makePage(W, H, false);
  const map = P.buildInkMap(page.rgba, W, H, Object.assign({ channel: 'lum' }, opts));
  const out = P.render(map, renderOpts);
  const f = score(out.gray, page.faint, [page.dark]);
  const d = score(out.gray, page.dark, [page.faint]);
  console.log('lum: faint recall %s, dark recall %s, false positives %s',
    f.recall.toFixed(3), d.recall.toFixed(3), f.fpRate.toFixed(5));
  assert(f.recall > 0.9, 'faint pencil should be recovered');
  assert(d.recall > 0.95, 'dark pen should be recovered');
  assert(f.fpRate < 0.002, 'paper, gradient and shadow should stay white');

  const smooth = P.render(map, Object.assign({}, renderOpts, { mode: 'smooth', bolden: 1 }));
  assert.strictEqual(smooth.gray.length, W * H);
  assert(score(smooth.gray, page.faint, [page.dark]).recall > 0.9, 'smooth mode keeps faint strokes dark');
}

{
  const page = makePage(W, H, true);
  const map = P.buildInkMap(page.rgba, W, H, Object.assign({ channel: 'dropColor' }, opts));
  const out = P.render(map, renderOpts);
  const f = score(out.gray, page.faint, [page.dark, page.ruled]);
  const r = score(out.gray, page.ruled, [page.dark, page.faint]);
  console.log('dropColor: faint recall %s, ruled lines kept %s', f.recall.toFixed(3), r.recall.toFixed(3));
  assert(f.recall > 0.9, 'faint pencil survives color filtering');
  assert(r.recall < 0.05, 'light blue ruled lines are dropped');
}

{
  // A blank, noisy page should come out (almost) empty.
  const n = W * H, rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { const v = 215 + gauss() * 20; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
  const out = P.render(P.buildInkMap(rgba, W, H, Object.assign({ channel: 'lum' }, opts)), renderOpts);
  console.log('blank page ink fraction %s', out.inkFraction.toFixed(5));
  assert(out.inkFraction < 0.001, 'blank page stays blank');
}

console.log('All processing tests passed.');
