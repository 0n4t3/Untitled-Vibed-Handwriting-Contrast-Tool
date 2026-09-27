# Handwriting Contrast

A small, fully local web app that turns photos or scans of handwriting into clean,
high-contrast black-and-white images. It's built for the case where document scanner
apps' B&W filters wipe out faint writing, like light gray pencil. This tool looks for
the strokes and makes them solid black while the paper, shadows, and grain go white.

**Everything runs in your browser.** There's no server, no upload, no analytics, and
no external fonts or libraries. The page's Content-Security-Policy blocks all network
connections, so images can't leave your machine even by accident.

## Using it

1. Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari). Double-clicking
   the file works, and you don't need a web server. If you'd rather serve it, anything
   static works, e.g. `python3 -m http.server` in this folder.
2. Add images: drag and drop, click **Add images**, or paste from the clipboard.
   Several pages at once are fine.
3. Tweak if needed:
   - **Sensitivity**: raise it to pick up fainter pencil; lower it if paper texture
     or smudges show up.
   - **Thicken strokes**: bolds thin writing so it's easier to read or OCR.
   - **Output**: *Pure black & white* (1 color per pixel) or *Smooth edges*
     (anti-aliased, still essentially B&W).
   - **Ink color**:
     - *Pencil / black / any*: the default.
     - *Colored ink*: keeps blue or red pen strong.
     - *Drop light colored marks*: removes things like blue ruled lines while
       keeping gray pencil.
   - **Advanced**: lighting-correction size, noise smoothing, speck removal, stroke
     confidence, and the working resolution.
4. Check the result with **Compare** (drag the divider) or hold <kbd>Space</kbd> to
   peek at the original. Rotate with the toolbar buttons; <kbd>←</kbd>/<kbd>→</kbd>
   switch images.
5. Save: **Download PNG**, **Copy** to clipboard, **All as ZIP**, or **All as PDF**
   (one page per image, stored losslessly).

Settings are remembered in your browser between visits. Double-click any slider to
reset it.

## How it works

`js/processing.js` holds the whole pipeline:

1. **Flatten the lighting.** It estimates the paper's brightness everywhere in the
   photo, using a local maximum filter (ink strokes are thin, so the brightest nearby
   pixel is paper) that's then blurred. Dividing the image by that estimate removes
   shadows, gradients and paper tint. What's left is an "ink map": 0 for paper, up to
   1 for black.
2. **Measure the noise locally.** For each region it measures the paper level and
   noise from the lower part of the brightness distribution, which is always paper
   even where there's writing. Thresholds are set in multiples of that local noise, so
   a dark shadow (where noise gets amplified) doesn't turn into a black blob, and a
   clean scan doesn't need a fixed gray cutoff.
3. **Hysteresis thresholding.** Pixels clearly darker than the paper start a stroke.
   The stroke then grows into connected, fainter pixels. That's how light pencil gets
   picked up without the paper grain, which never reaches the "clearly darker" level.
   Faint pixels right beside much darker ink are treated as blur halo and trimmed, so
   bold pen doesn't get fattened.
4. **Clean up.** It removes tiny isolated specks, renders the result, and optionally
   thickens strokes.

In the color modes, each RGB channel is flattened against its own background before
the channels are combined. That's why light blue lines on yellowish paper can be
dropped while neutral gray pencil stays.

## Tests

```sh
node test/processing.test.js
```

The tests run the pipeline on synthetic pages: faint pencil and dark pen under a strong
lighting gradient and shadow, blue ruled lines, and a blank noisy page. They check that
the writing is recovered and the paper stays white.

## Files

```
index.html            UI markup
css/style.css         styles (light and dark themes)
js/processing.js      image processing pipeline (no DOM, also runs under Node)
js/export.js          dependency-free ZIP and PDF writers
js/app.js             UI: loading, preview, compare, zoom, export
test/                 Node sanity tests for the pipeline
```

## Limitations

- HEIC photos (iPhone default) only decode in browsers that support HEIC, such as
  Safari. Elsewhere, export them as JPEG first.
- It doesn't crop or de-skew pages. Run it on photos that are already roughly cropped,
  or on your scanner app's color output.
- Very large images at *Original size* can take a few seconds per adjustment. The
  default 3000 px working size (about 300 dpi for a letter/A4 page) is usually plenty.
