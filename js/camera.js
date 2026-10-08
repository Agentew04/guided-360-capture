import { exifFromBlob, fovFromFocal, assumedFov } from "./fov.js";

// Safari ships takePhoto but it reconfigures the capture session on every shot: the
// preview goes black and each still allocates a sensor-sized buffer that kills the
// tab after a handful. Canvas on iOS, real stills everywhere else.
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const USE_STILL = !IS_IOS && ("ImageCapture" in window);

const JPEG_QUALITY = 0.92;
const SHOT_AR = 3 / 4;  // width/height, in portrait
const LONG_EDGE = 4032; // canvas path only: the photo is the whole preview frame, up to 12MP

// Measured on a Xiaomi (Android 16): the still menu holds 2448x3264, 1920x2560 and
// 1440x1920 at a true 3:4, plus a 2256x4000 16:9 that is the DEFAULT and crops 25%
// off the width. So always ask for a size - never take takePhoto()'s default.
const STILL_SETTINGS = { imageWidth: 3264, imageHeight: 2448 };

const video = document.getElementById("video");
let stream = null;
let imageCapture = null;
let frameLoopGen = 0;
let frameListener = () => {};

export const hasVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
export let frameSeq = 0;
export let previewLabel = "…";
export let shotW = 0, shotH = 0;
export let shotFov = null;
let probedFov = null;
let probePromise = null;

export function onFrame(listener) {
  frameListener = listener;
}

// Ask for ONE edge, never a width+height pair: Chrome/Android resolves a pair in sensor
// space and silently returns a landscape crop. Measured on a Xiaomi (Android 16),
// {width:exact 1440, height:exact 1920} came back 1920x1440 with the top and bottom
// cut off; the short edge alone returns a true portrait 3:4 track. iOS honours either.
// applyConstraints can lower a resolution but never raise it, so each rung is a fresh
// getUserMedia.
//
// With a real still the preview is only a viewfinder, so take the lightest 3:4 track.
// Without one the photo IS a preview frame, so take the biggest, down from 12MP.
function shortEdgeLadder() {
  return USE_STILL ? [1080, 960, 1200, 1440, 1920] : [3024, 2448, 1920, 1440, 1080];
}

// A track can answer the right size with the wrong shape - {height: exact 720} came
// back 720x720 square on the Xiaomi - so check what arrived instead of trusting it.
function isPhotoShaped(s) {
  const ar = (s.width || 0) / (s.height || 1);
  return Math.abs(ar - SHOT_AR) < 0.02 || Math.abs(ar - 1 / SHOT_AR) < 0.02;
}

export async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;

  imageCapture = null;

  const face = { ideal: "environment" };
  let lastErr = null;
  for (const h of shortEdgeLadder()) {
    let candidate = null;
    try {
      candidate = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: face, height: { exact: h } }, audio: false
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (isPhotoShaped(candidate.getVideoTracks()[0].getSettings())) {
      stream = candidate;
      break;
    }
    candidate.getTracks().forEach((t) => t.stop());
  }
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: face }, audio: false });
    } catch (err) {
      throw lastErr || err;
    }
  }

  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];

  if (USE_STILL) {
    try { imageCapture = new ImageCapture(track); } catch (_) {}
  }

  const s2 = track.getSettings();
  previewLabel = s2.width + "×" + s2.height;
  await video.play().catch(() => {});

  startFrameLoop();
}

// Re-attaching srcObject cancels any pending requestVideoFrameCallback, so the loop
// has to be restartable. The generation token keeps a resurrected chain from running
// alongside an old one that turned out to be alive. The frame listener runs here, in
// step with the frame it draws over.
function startFrameLoop() {
  if (!hasVFC) return;
  const gen = ++frameLoopGen;
  const tick = () => {
    if (gen !== frameLoopGen) return;
    frameSeq++;
    video.requestVideoFrameCallback(tick); // re-armed first: a drawing error must not stop the loop
    frameListener();
  };
  video.requestVideoFrameCallback(tick);
}

export function resumePreview() {
  video.play().catch(() => {});
}

// iOS pauses the element under memory pressure and after a backgrounding.
video.addEventListener("pause", () => { if (stream) resumePreview(); });

// Resolves true as soon as a freshly decoded frame lands, false on timeout.
function waitForFrame(ms) {
  if (!hasVFC) return new Promise((res) => setTimeout(() => res(true), 60));
  const seen = frameSeq;
  return new Promise((res) => {
    const t0 = performance.now();
    const poll = () => {
      if (frameSeq !== seen) return res(true);
      if (performance.now() - t0 >= ms) return res(false);
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

// After a canvas read-back WebKit sometimes drops the video compositing layer: the
// stream is still live, the element just paints black. Re-attaching srcObject hands
// it a fresh surface; only a genuinely dead track needs the session rebuilt.
async function recoverPreview() {
  if (video.paused) await video.play().catch(() => {});
  if (await waitForFrame(200)) return;

  video.srcObject = null;
  video.srcObject = stream;
  await video.play().catch(() => {});
  startFrameLoop();
  if (await waitForFrame(500)) return;

  try { await startCamera(); } catch (_) {}
}

// Read the JPEG frame header rather than decoding: createImageBitmap on an 8MP still,
// once per shot, is the allocation pattern that kills a mobile tab.
async function jpegSize(blob) {
  try {
    const b = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  } catch (_) {}
  return null;
}

async function setShotFov(blob) {
  if (probePromise) await probePromise;
  const exif = await exifFromBlob(blob);
  let w = shotW, h = shotH;
  if (!w || !h) { w = 3; h = 4; }
  const orientation = (exif && exif.orientation) || 1;
  if (orientation >= 5) { const t = w; w = h; h = t; }
  const f35 = (exif && exif.focal35mm) || (probedFov && probedFov.focal35mm) || null;
  const base = f35 ? fovFromFocal(f35, w, h) : assumedFov(w, h);
  if (f35 && !(exif && exif.focal35mm)) base.source = "exif-probe";
  shotFov = { ...base, width: w, height: h, orientation };
}

// iOS canvas grabs have no EXIF, so take a single throwaway still up front just to read
// the lens. It reconfigures the capture session once, which the canvas path can survive;
// the per-shot takePhoto is what kills the tab. Best effort, never blocks the run.
export function probeStillFov() {
  if (probePromise || !IS_IOS || !("ImageCapture" in window) || !stream) return probePromise;
  probePromise = (async () => {
    let probe = null;
    try { probe = new ImageCapture(stream.getVideoTracks()[0]); } catch (_) { return; }
    try {
      const blob = await Promise.race([
        probe.takePhoto(),
        new Promise((res) => setTimeout(() => res(null), 4000)),
      ]);
      if (blob) {
        const exif = await exifFromBlob(blob);
        if (exif && exif.focal35mm) probedFov = exif;
      }
    } catch (_) {
    } finally {
      await recoverPreview();
    }
  })();
  return probePromise;
}

// One reused canvas. Resize only when the frame size changes (realloc leaks on iOS).
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

export async function capturePhoto() {
  if (imageCapture) {
    try {
      const blob = await imageCapture.takePhoto(STILL_SETTINGS);
      // takePhoto drops the compositing layer on Android too, same as the canvas grab.
      await recoverPreview();
      // STILL_SETTINGS is a request, not a promise: a device that ignores it can
      // hand back its 16:9 default. Checking beats shipping a pack of mixed shapes.
      const d = await jpegSize(blob);
      if (!d || isPhotoShaped({ width: d.w, height: d.h })) {
        shotW = d ? d.w : 0;
        shotH = d ? d.h : 0;
        await setShotFov(blob);
        return blob;
      }
      imageCapture = null; // wrong shape: the canvas crops reliably, use it instead
    } catch (_) {
      imageCapture = null; // one strike: canvas for the rest of the run
    }
  }

  // Never grab a stale frame: mid-recovery the preview draws black.
  if (video.paused) await video.play().catch(() => {});
  await waitForFrame(400);

  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  // Target orientation comes from the SCREEN, not the frame. The preview is a fixed
  // 3:4 box using object-fit: cover, so deriving the crop the same way keeps what you
  // see and what is saved identical even if a driver hands back a landscape track.
  const ar = (window.innerHeight >= window.innerWidth) ? SHOT_AR : 1 / SHOT_AR;
  let sw = vw, sh = vh;
  if (vw / vh > ar) sw = Math.round(vh * ar);
  else sh = Math.round(vw / ar);
  const sx = Math.round((vw - sw) / 2);
  const sy = Math.round((vh - sh) / 2);

  // Cap the long edge, then derive the short one so the ratio stays exact.
  const scale = Math.min(1, LONG_EDGE / Math.max(sw, sh));
  let w, h;
  if (sh >= sw) { h = Math.round(sh * scale); w = Math.round(h * ar); }
  else { w = Math.round(sw * scale); h = Math.round(w / ar); }

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  shotW = w;
  shotH = h;

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  await setShotFov(blob);
  await recoverPreview();
  return blob;
}
