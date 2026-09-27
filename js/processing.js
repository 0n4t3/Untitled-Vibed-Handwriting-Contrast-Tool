/*
 * Handwriting contrast pipeline. Pure functions over typed arrays so it can run
 * in the browser (global `HWProcess`) or under Node for tests (module.exports).
 *
 * Pipeline:
 *   1. RGBA -> luminance, or each color channel separately (color modes)
 *   2. Light pre-blur to suppress sensor + JPEG noise
 *   3. Estimate the paper ("background") brightness everywhere: downsample,
 *      local max filter (ink is thin, so the max is paper), blur, upsample
 *   4. Divide by the background -> flat white paper, shadows/gradients removed.
 *      ink = 1 - gray/background  (0 = paper, 1 = black). In color modes the
 *      per-channel ink maps are combined: max keeps colored ink strong, min
 *      drops anything that isn't dark in every channel (e.g. blue ruling)
 *   5. Measure the paper's level and noise per region, so thresholds adapt to
 *      each part of the photo (noise is amplified in shadows)
 *   6. Hysteresis threshold: pixels clearly darker than paper seed strokes,
 *      which then grow into connected fainter pixels (catches light pencil
 *      without picking up paper grain). Pixels much lighter than the darkest
 *      ink right next to them are stroke halo, not stroke, and are trimmed so
 *      bold pen doesn't get fattened by thresholds tuned for faint pencil
 *   7. Remove tiny specks, render black/white (or smooth-edged) output,
 *      optionally thicken strokes
 */
(function (root) {
  'use strict';

  // A pixel lighter than this fraction of the darkest ink beside it is halo.
  const HALO = 0.3;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // ---- Stage A: grayscale -------------------------------------------------

  // channel: 'lum' or an RGBA offset (0 = R, 1 = G, 2 = B)
  function toGray(rgba, n, channel) {
    const gray = new Float32Array(n);
    if (channel === 'lum') {
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      }
    } else {
      for (let i = 0, p = channel; i < n; i++, p += 4) gray[i] = rgba[p];
    }
    return gray;
  }

  // ---- Filters ------------------------------------------------------------

  // Separable box blur with clamped edges, O(n) regardless of radius.
  function boxBlur(src, w, h, r) {
    if (r < 1) return src;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const div = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / div;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        sum += src[row + add] - src[row + sub];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / div;
        const add = Math.min(h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        sum += tmp[add * w + x] - tmp[sub * w + x];
      }
    }
    return out;
  }

  // Separable max (isMax) or min filter over a square window. Used on small
  // (downsampled) images or with small radii, so the direct form is fine.
  function rankFilter(src, w, h, r, isMax) {
    if (r < 1) return src;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        let m = src[row + x0];
        for (let k = x0 + 1; k <= x1; k++) {
          const v = src[row + k];
          if (isMax ? v > m : v < m) m = v;
        }
        tmp[row + x] = m;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
        let m = tmp[y0 * w + x];
        for (let k = y0 + 1; k <= y1; k++) {
          const v = tmp[k * w + x];
          if (isMax ? v > m : v < m) m = v;
        }
        out[y * w + x] = m;
      }
    }
    return out;
  }

  function downsampleAvg(src, w, h, f) {
    const sw = Math.ceil(w / f), sh = Math.ceil(h / f);
    const out = new Float32Array(sw * sh);
    for (let sy = 0; sy < sh; sy++) {
      const y0 = sy * f, y1 = Math.min(h, y0 + f);
      for (let sx = 0; sx < sw; sx++) {
        const x0 = sx * f, x1 = Math.min(w, x0 + f);
        let sum = 0;
        for (let y = y0; y < y1; y++) {
          const row = y * w;
          for (let x = x0; x < x1; x++) sum += src[row + x];
        }
        out[sy * sw + sx] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return { data: out, w: sw, h: sh };
  }

  // Bilinear upsample of a block-averaged image back to full size.
  function upsample(small, sw, sh, w, h, f) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let fy = (y + 0.5) / f - 0.5;
      if (fy < 0) fy = 0;
      let y0 = Math.floor(fy);
      if (y0 > sh - 1) y0 = sh - 1;
      const y1 = Math.min(sh - 1, y0 + 1);
      const ty = Math.min(1, fy - y0);
      for (let x = 0; x < w; x++) {
        let fx = (x + 0.5) / f - 0.5;
        if (fx < 0) fx = 0;
        let x0 = Math.floor(fx);
        if (x0 > sw - 1) x0 = sw - 1;
        const x1 = Math.min(sw - 1, x0 + 1);
        const tx = Math.min(1, fx - x0);
        const a = small[y0 * sw + x0], b = small[y0 * sw + x1];
        const c = small[y1 * sw + x0], d = small[y1 * sw + x1];
        out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      }
    }
    return out;
  }

  // ---- Stage B: flatten lighting, build ink map + noise stats ------------

  function estimateBackground(gray, w, h, radius) {
    // Work at a reduced scale so large radii stay cheap.
    const f = Math.max(1, Math.round(radius / 10));
    const small = downsampleAvg(gray, w, h, f);
    const r = Math.max(1, Math.round(radius / f));
    let bg = rankFilter(small.data, small.w, small.h, r, true);
    bg = boxBlur(bg, small.w, small.h, r);
    bg = boxBlur(bg, small.w, small.h, r);
    return upsample(bg, small.w, small.h, w, h, f);
  }

  /**
   * Per-block paper level (M) and noise (S) of the ink map, upsampled to full
   * size. Ink only ever adds to the upper tail, so both are estimated from the
   * lower quantiles, which stay paper-only even in blocks that are ~40% ink:
   * for Gaussian noise q10 = m - 1.2816 s and q30 = m - 0.5244 s.
   */
  function localStats(ink, w, h, B) {
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    const M = new Float32Array(bw * bh);
    const S = new Float32Array(bw * bh);
    const step = Math.max(1, Math.floor(B / 24));
    const buf = new Float32Array(Math.ceil(B / step) * Math.ceil(B / step));
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let n = 0;
        const y1 = Math.min(h, (by + 1) * B), x1 = Math.min(w, (bx + 1) * B);
        for (let y = by * B; y < y1; y += step) {
          for (let x = bx * B; x < x1; x += step) buf[n++] = ink[y * w + x];
        }
        const v = buf.subarray(0, n).sort();
        const q10 = v[Math.floor(0.1 * (n - 1))], q30 = v[Math.floor(0.3 * (n - 1))];
        const sigma = Math.max(0.003, (q30 - q10) / 0.7572);
        S[by * bw + bx] = sigma;
        M[by * bw + bx] = q30 + 0.5244 * sigma;
      }
    }
    const blurM = boxBlur(M, bw, bh, 1), blurS = boxBlur(S, bw, bh, 1);
    return { M: upsample(blurM, bw, bh, w, h, B), S: upsample(blurS, bw, bh, w, h, B) };
  }

  /**
   * Build the normalized ink map (0 = paper, 1 = darkest) and local stats.
   * opts: { channel: 'lum'|'keepColor'|'dropColor', backgroundRadius (px), smoothing (px) }
   */
  function buildInkMap(rgba, w, h, opts) {
    const n = w * h;
    const s = Math.round(opts.smoothing || 0);
    const radius = Math.max(4, opts.backgroundRadius);
    const channels = opts.channel === 'keepColor' || opts.channel === 'dropColor' ? [0, 1, 2] : ['lum'];
    const keep = opts.channel === 'keepColor';
    let ink = null;
    for (const ch of channels) {
      let gray = toGray(rgba, n, ch);
      if (s > 0) gray = boxBlur(boxBlur(gray, w, h, s), w, h, s);
      const bg = estimateBackground(gray, w, h, radius);
      if (!ink) {
        ink = bg; // reuse buffer
        for (let i = 0; i < n; i++) {
          const v = 1 - gray[i] / (bg[i] < 8 ? 8 : bg[i]);
          ink[i] = v < -1 ? -1 : v > 1 ? 1 : v;
        }
      } else {
        for (let i = 0; i < n; i++) {
          let v = 1 - gray[i] / (bg[i] < 8 ? 8 : bg[i]);
          v = v < -1 ? -1 : v > 1 ? 1 : v;
          if (keep ? v > ink[i] : v < ink[i]) ink[i] = v;
        }
      }
    }
    const block = Math.min(128, Math.max(24, Math.round(radius)));
    const { M, S } = localStats(ink, w, h, block);
    const peak = rankFilter(ink, w, h, 2 + s, true); // darkest ink nearby
    return { ink, M, S, peak, w, h };
  }

  // ---- Stage C: thresholds, masks, rendering ------------------------------

  // Sensitivity 0..100 -> how many local noise-sigmas above paper counts as
  // ink, with a small absolute floor so ultra-clean scans don't pick up
  // compression ripples.
  function thresholdParams(opts) {
    const s = clamp01((opts.sensitivity == null ? 60 : opts.sensitivity) / 100);
    return {
      k: 12 * Math.pow(1.5 / 12, s), // 12 sigma (strict) .. 1.5 sigma (loose)
      floor: 0.012 + 0.03 * (1 - s),
      ratio: Math.max(1, opts.seedRatio || 2),
    };
  }

  // Keep pixels >= weak that are 8-connected to some pixel >= strong.
  function hysteresis(ink, w, h, weak, strong) {
    const n = w * h;
    const mask = new Uint8Array(n);
    const stack = new Int32Array(n);
    let sp = 0;
    for (let i = 0; i < n; i++) {
      if (ink[i] >= strong && !mask[i]) {
        mask[i] = 1;
        stack[sp++] = i;
        while (sp > 0) {
          const p = stack[--sp];
          const x = p % w, y = (p - x) / w;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              const q = yy * w + xx;
              if (!mask[q] && ink[q] >= weak) { mask[q] = 1; stack[sp++] = q; }
            }
          }
        }
      }
    }
    return mask;
  }

  // Remove 8-connected components smaller than minArea pixels (in place).
  function despeckle(mask, w, h, minArea) {
    if (minArea < 2) return mask;
    const n = w * h;
    const seen = new Uint8Array(n);
    const comp = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      if (!mask[i] || seen[i]) continue;
      let head = 0, tail = 0;
      comp[tail++] = i;
      seen[i] = 1;
      while (head < tail) {
        const p = comp[head++];
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (mask[q] && !seen[q]) { seen[q] = 1; comp[tail++] = q; }
          }
        }
      }
      if (tail < minArea) for (let k = 0; k < tail; k++) mask[comp[k]] = 0;
    }
    return mask;
  }

  /**
   * Render the final image.
   * opts: { sensitivity, seedRatio, speckArea (px), bolden (px), mode: 'binary'|'smooth' }
   * Returns { gray: Uint8ClampedArray (0 = ink, 255 = paper), inkFraction }
   */
  function render(inkMap, opts) {
    const { ink, M, S, peak, w, h } = inkMap;
    const n = w * h;
    const t = thresholdParams(opts);
    // u = contrast above local paper in units of the local weak threshold:
    // u >= 1 is a candidate ink pixel, u >= ratio is a confident one.
    const u = new Float32Array(n);
    const core = new Float32Array(n); // u with stroke halos removed
    for (let i = 0; i < n; i++) {
      const th = t.k * S[i];
      const e = ink[i] - M[i];
      u[i] = e / (th > t.floor ? th : t.floor);
      core[i] = e >= HALO * (peak[i] - M[i]) ? u[i] : 0;
    }
    const mask = hysteresis(core, w, h, 1, t.ratio);
    despeckle(mask, w, h, Math.round(opts.speckArea || 0));

    let out = new Float32Array(n);
    let count = 0;
    if (opts.mode === 'smooth') {
      // Grow the mask by one pixel so anti-aliased stroke edges survive, then
      // map ink strength onto a curve that pushes even faint strokes dark.
      const grown = rankFilter(mask, w, h, 1, true);
      const span = Math.max(0.5, t.ratio - 0.5);
      for (let i = 0; i < n; i++) {
        if (mask[i]) count++;
        if (!grown[i]) { out[i] = 255; continue; }
        let d = clamp01((u[i] - 0.5) / span);
        d = 1 - (1 - d) * (1 - d);
        if (mask[i] && d < 0.55) d = 0.55;
        out[i] = 255 * (1 - d);
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (mask[i]) { out[i] = 0; count++; } else out[i] = 255;
      }
    }

    const b = Math.round(opts.bolden || 0);
    if (b > 0) out = rankFilter(out, w, h, b, false);

    const gray = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) gray[i] = out[i];
    return { gray, inkFraction: count / n };
  }

  function grayToRGBA(gray, rgba) {
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      const v = gray[i];
      rgba[p] = v; rgba[p + 1] = v; rgba[p + 2] = v; rgba[p + 3] = 255;
    }
    return rgba;
  }

  const api = { buildInkMap, render, grayToRGBA, boxBlur, rankFilter, localStats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HWProcess = api;
})(typeof self !== 'undefined' ? self : this);
