import {
  TOTAL_SHOTS, LEVEL_TARGETS, LEVEL_SHOTS, photos, currentLevel, currentShot,
  headingLost, isDone, resetSession, restoreSession,
  anchorHeading, loseHeading, recalibrate, shotFailed, shotTaken, undoShot,
} from "./session.js";
import {
  gyroActive, gotOrientation, rawPitch, rawYaw, displayPitch, displayYaw,
  requestGyro, startOrientation, stopOrientation, smoothOrientation, forgetHeading,
  captureRotation,
} from "./orientation.js";
import { hasVFC, onFrame, startCamera, stopCamera, capturePhoto, resumePreview, probeStillFov, shotFov, adoptFov, previewSharpness } from "./camera.js";
import { isBlurry } from "./sharpness.js";
import { updateTilt, updateHUD, updatePerf, countFrame, showShot, showSharpness, setPrompt } from "./hud.js";
import { initDome, drawDome } from "./dome.js";
import { initTargets, drawTargets } from "./targets.js";
import { holdProgress, updateAutoShot } from "./autoshot.js";
import { openStorage, savePhoto, deletePhoto, clearStorage, readPhoto, readMeta, photoKey } from "./storage.js";
import { buildZip } from "./zip.js";
import { buildPto } from "./pto.js";
import { describeDevice } from "./device.js";
import { stitchCapture } from "./library.js";

const $ = (id) => document.getElementById(id);
const intro = $("intro"), capture = $("capture");
const startBtn = $("start-btn"), restartBtn = $("restart-btn"), errorEl = $("error");
const undoBtn = $("undo-btn"), exportBtn = $("export-btn"), stitchBtn = $("stitch-btn");
const flash = $("flash"), blurToast = $("blur-toast");
const exportLabel = exportBtn.textContent;

let running = false;
let busy = false;
let storedCount = 0; // photos an earlier page left behind, from shot 1 with no gaps
let restartArmed = false;
let wakeLock = null;
const rejectedShots = []; // blur rejections, logged to metadata without the image
let retryAfter = 0;       // pause auto-shot after a rejection so the toast cannot spam
let rejectStreak = 0;     // consecutive rejects at this slot; see the cap in shoot()
let blurTimer = null;

const dbReady = openStorage().then((n) => {
  storedCount = n;
  if (storedCount) {
    startBtn.textContent = `Continue (${storedCount} of ${TOTAL_SHOTS})`;
    restartBtn.classList.remove("hidden");
  }
});

startBtn.addEventListener("click", () => begin(true));

// Two taps rather than confirm(): a modal between the tap and requestPermission could
// cost iOS the user gesture it insists on.
restartBtn.addEventListener("click", () => {
  if (!restartArmed) {
    restartArmed = true;
    restartBtn.textContent = `Tap again to discard ${storedCount} photos`;
    return;
  }
  begin(false);
});

async function begin(resume) {
  errorEl.classList.add("hidden");
  startBtn.disabled = restartBtn.disabled = true;

  // Before anything else is awaited: iOS only grants orientation from inside the tap.
  await requestGyro();

  await dbReady;
  resetSession();
  rejectedShots.length = 0;
  retryAfter = 0;
  rejectStreak = 0;
  hideBlur();
  if (resume && storedCount) {
    restoreSession(storedCount);
    for (const p of photos) {
      const m = await readMeta(p);
      if (m) {
        p.rotation = m.rotation; p.fov = m.fov; p.target = m.target;
        p.sharpness = m.sharpness || null;
        p.blurry = !!m.blurry;
        adoptFov(m.fov);
      }
    }
  } else {
    await clearStorage();
    storedCount = 0;
  }

  try {
    await startCamera();
  } catch (err) {
    errorEl.textContent = "Camera error: " + err.message + " (needs an HTTPS page)";
    errorEl.classList.remove("hidden");
    startBtn.disabled = restartBtn.disabled = false;
    return;
  }

  if (gyroActive) {
    startOrientation();
    setTimeout(() => { if (!gotOrientation) noSensor(); }, 2000);
  } else {
    noSensor();
  }

  intro.classList.replace("active", "hidden");
  capture.classList.replace("hidden", "active");

  running = true;
  keepAwake();
  initDome();
  initTargets();
  updateHUD();
  updatePerf();
  probeStillFov();
  requestAnimationFrame(renderLoop);
}

function noSensor() {
  stopOrientation();
  updateHUD();
}

// The browser drops the lock when the page is hidden.
function keepAwake() {
  if ("wakeLock" in navigator) navigator.wakeLock.request("screen").then((lock) => { wakeLock = lock; }, () => {});
}

function leaveCapture() {
  running = false;
  stopOrientation();
  stopCamera();
  hideBlur();
  wakeLock?.release().catch(() => {});
  wakeLock = null;

  storedCount = photos.length;
  startBtn.textContent = `Continue (${storedCount} of ${TOTAL_SHOTS})`;
  restartArmed = false;
  restartBtn.textContent = "Start over";
  restartBtn.classList.remove("hidden");
  startBtn.disabled = restartBtn.disabled = false;
}

document.addEventListener("visibilitychange", () => {
  if (!running) return;
  if (document.hidden) {
    // Relative yaw may restart while hidden, same as a reload.
    loseHeading(busy);
    forgetHeading();
    updateHUD();
    return;
  }
  resumePreview();
  keepAwake();
});

window.addEventListener("resize", () => { if (running) initTargets(); });

onFrame(() => drawTargets(holdProgress));

function renderLoop(now) {
  if (!running) return;
  smoothOrientation();
  if (gyroActive && rawPitch !== null) updateTilt(displayPitch);
  if (gyroActive && rawYaw !== null) anchorHeading(displayYaw);
  if (updateAutoShot(now, busy) && now >= retryAfter) shoot();
  drawDome();
  if (!hasVFC) drawTargets(holdProgress);
  countFrame(now);
  requestAnimationFrame(renderLoop);
}

undoBtn.addEventListener("click", () => {
  if (busy) return;
  rejectStreak = 0;

  // Recalibration: aimed back at the last photo, so no photo is taken.
  if (headingLost() && gyroActive && rawYaw !== null) {
    recalibrate(rawYaw);
    updateHUD();
    return;
  }
  if (!photos.length) return;
  if (isDone()) {
    exportBtn.disabled = false;
    exportBtn.textContent = exportLabel;
  }
  deletePhoto(undoShot());
  updateHUD();
});

const round4 = (v) => Math.round(v * 10000) / 10000;

function warnBlur() {
  blurToast.textContent = "Out of focus - take it again";
  blurToast.classList.add("show");
  undoBtn.classList.add("alert");
  clearTimeout(blurTimer);
  blurTimer = setTimeout(hideBlur, 4000);
}

function hideBlur() {
  clearTimeout(blurTimer);
  blurTimer = null;
  blurToast.classList.remove("show");
  undoBtn.classList.remove("alert");
}

async function shoot() {
  busy = true;
  // Before capturePhoto(): takePhoto drops the preview layer, and on Android the still
  // comes off a different pipeline, so the preview is the reference to compare against.
  const preview = previewSharpness();
  const rotation = captureRotation(); // the capture can take a second, and the phone moves on

  flash.classList.add("animate");
  setTimeout(() => flash.classList.remove("animate"), 180);

  undoBtn.disabled = true;
  let shot = null;
  try {
    shot = await capturePhoto();
  } catch (_) {}
  undoBtn.disabled = !photos.length;
  busy = false;

  if (!shot) {
    shotFailed();
    setPrompt("Frame dropped - hold still to try again.");
    return;
  }

  const { blob, sharpness } = shot;
  showSharpness(sharpness);

  if (isBlurry(sharpness, preview)) {
    rejectedShots.push({
      level: currentLevel + 1,
      shot: currentShot + 1,
      score: sharpness ? round4(sharpness.score) : null,
      contrast: sharpness ? round4(sharpness.contrast) : null,
    });
    shotFailed();                        // a dropped shot, not a taken one
    rejectStreak++;

    // The metric cannot judge every surface, so never trap the run: after three
    // rejections at the same slot keep the shot, flagged in the metadata.
    if (rejectStreak >= 3) {
      hideBlur();
      rejectStreak = 0;
      showShot(blob.size);
      savePhoto(shotTaken(blob, rotation, shotFov, sharpness, true));
      updateHUD();
      setPrompt("Saved anyway - focus uncertain.");
      return;
    }

    warnBlur();
    retryAfter = performance.now() + 1500;
    updateHUD();
    setPrompt("Out of focus - take it again.");
    return;
  }

  rejectStreak = 0;
  hideBlur();
  // Size from the blob directly - no createImageBitmap (that bitmap leaked memory on iOS).
  showShot(blob.size);
  savePhoto(shotTaken(blob, rotation, shotFov, sharpness));
  updateHUD();
}

async function packPhotos() {
  const files = [];
  const entries = [];
  const fovSources = new Set();
  for (const p of photos) {
    const blob = await readPhoto(p);
    if (!blob) throw new Error(`shot ${photoKey(p) + 1} is missing from storage`);
    const l = String(p.level + 1).padStart(2, "0");
    const s = String(p.shot + 1).padStart(2, "0");
    const name = `360_photos/level_${l}_shot_${s}.jpg`;
    files.push({ name, blob });
    if (p.fov && p.fov.source) fovSources.add(p.fov.source);
    entries.push({
      file: name,
      level: p.level + 1,
      shot: p.shot + 1,
      tilt: LEVEL_TARGETS[p.level],
      fov: p.fov || null,
      rotation: p.rotation || null,
      target: p.target || null,
      sharpness: p.sharpness || null,
      blurry: !!p.blurry,
    });
  }

  const doc = {
    format: "guided-360-capture/v1",
    generated: new Date().toISOString(),
    device: await describeDevice(),
    shotLayout: { tiltDegrees: LEVEL_TARGETS, shotsPerLevel: LEVEL_SHOTS },
    fovSource: fovSources.size === 1 ? [...fovSources][0] : "mixed",
    conventions: {
      rotation: "yaw/clkwise-from-level-reference, pitch above horizon, roll about the optical axis, all degrees",
      matrix: "row-major 3x3 device-to-world; world X east, Y north, Z up; camera axis is device -Z",
      fov: "rectilinear degrees; horizontal across width, vertical across height, for the stored orientation",
    },
    photos: entries,
  };
  if (rejectedShots.length) doc.rejected = rejectedShots;
  files.push({ name: "metadata.json", blob: new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }) });
  try {
    files.push({ name: "pano.pto", blob: new Blob([buildPto(doc)], { type: "text/plain" }) });
  } catch (err) {
    console.warn("Skipping pano.pto:", err.message);
  }

  return buildZip(files);
}

stitchBtn.addEventListener("click", async () => {
  const label = stitchBtn.textContent;
  stitchBtn.disabled = true;
  stitchBtn.textContent = "Packing…";
  let content;
  try {
    content = await packPhotos();
  } catch (err) {
    alert("Failed to build ZIP: " + err.message);
    return;
  } finally {
    stitchBtn.disabled = false;
    stitchBtn.textContent = label;
  }
  leaveCapture();
  stitchCapture(content);
});

exportBtn.addEventListener("click", async () => {
  const label = exportBtn.textContent;
  exportBtn.disabled = true;
  exportBtn.textContent = "Packing…";
  try {
    const content = await packPhotos();
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "360_photos.zip";
    // Not revoked: Opera only reads the URL once the user confirms its download prompt,
    // and a revoked one crashed it.
    a.click();
    exportBtn.textContent = "Downloaded!";
  } catch (err) {
    alert("Failed to build ZIP: " + err.message);
    exportBtn.disabled = false;
    exportBtn.textContent = label;
  }
});
