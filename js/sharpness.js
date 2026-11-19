// Live focus check for the capture flow.
//
// Blur is judged by "acutance": the mean squared gradient normalised by the frame's
// variance. Normalising by variance makes the score far less sensitive to how textured
// the scene is than a raw Laplacian score, and a nearly flat surface (a blank ceiling)
// is let through because there is nothing to focus on.
//
// The still comes off a different pipeline than the preview on Android, so the still is
// also compared against the preview frame at the shutter: that catches autofocus that
// hunts during takePhoto without depending on scene texture.
export const ANALYSIS_EDGE = 240;   // short edge of the grayscale frame the metric sees
export const MIN_CONTRAST = 10;     // luma std dev below this: too flat to judge
export const MIN_ACUTANCE = 0.06;   // absolute floor; tune on device
export const RELATIVE_FLOOR = 0.5;  // a still must keep this share of the preview's score

let gray = new Uint8Array(0);

// rgba: ImageData.data (RGBA, 0..255). Returns { score, contrast } or null.
export function acutance(rgba, w, h) {
  const n = w * h;
  if (n < 4 || !rgba || rgba.length < n * 4 || w < 3 || h < 3) return null;
  if (gray.length < n) gray = new Uint8Array(n);

  let sum = 0;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const l = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
    gray[i] = l;
    sum += l;
  }
  const mean = sum / n;

  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = gray[i] - mean;
    variance += d * d;
  }
  variance /= n;

  let gradient = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      gradient += gx * gx + gy * gy;
    }
  }
  const pixels = (w - 2) * (h - 2);

  // gradient/pixels and variance are both in luma^2, so the ratio is dimensionless.
  return { score: (gradient / pixels) / (variance + 1e-3), contrast: Math.sqrt(variance) };
}

// preview: the focus measurement taken just before the shutter (may be null).
export function isBlurry(still, preview) {
  if (!still || !Number.isFinite(still.score)) return false;
  if (still.contrast < MIN_CONTRAST) return false; // blank surface: no edges to be soft
  if (still.score < MIN_ACUTANCE) return true;
  if (preview && Number.isFinite(preview.score) && preview.contrast >= MIN_CONTRAST &&
      preview.score > 0 && still.score < preview.score * RELATIVE_FLOOR) {
    return true;
  }
  return false;
}
