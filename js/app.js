import {
  TOTAL_SHOTS, LEVEL_TARGETS, LEVEL_SHOTS, photos, headingLost, isDone, resetSession, restoreSession,
  anchorHeading, loseHeading, recalibrate, shotFailed, shotTaken,
} from "./session.js";
import {
  gyroActive, gotOrientation, rawPitch, rawYaw, displayPitch, displayYaw,
  requestGyro, startOrientation, stopOrientation, smoothOrientation, forgetHeading,
  captureRotation,
} from "./orientation.js";
import { hasVFC, onFrame, startCamera, capturePhoto, resumePreview, shotFov } from "./camera.js";
import { updateTilt, updateSpin, hideGauges, updateHUD, updatePerf, countFrame, showShot, setPrompt } from "./hud.js";
import { initDome, drawDome } from "./dome.js";
import { initTargets, drawTargets } from "./targets.js";
import { holdProgress, updateAutoShot } from "./autoshot.js";
import { openStorage, savePhoto, clearStorage, readPhoto, readMeta, photoKey } from "./storage.js";
import { buildZip } from "./zip.js";

const $ = (id) => document.getElementById(id);
const intro = $("intro"), capture = $("capture");
const startBtn = $("start-btn"), restartBtn = $("restart-btn"), errorEl = $("error");
const captureBtn = $("capture-btn"), exportBtn = $("export-btn");
const flash = $("flash");

let running = false;
let busy = false;
let storedCount = 0; // photos an earlier page left behind, from shot 1 with no gaps
let restartArmed = false;

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
  if (resume && storedCount) {
    restoreSession(storedCount);
    for (const p of photos) {
      const m = await readMeta(p);
      if (m) { p.rotation = m.rotation; p.fov = m.fov; p.target = m.target; }
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
  requestAnimationFrame(renderLoop);
}

function noSensor() {
  stopOrientation();
  hideGauges();
  updateHUD();
}

// The browser drops the lock when the page is hidden.
function keepAwake() {
  if ("wakeLock" in navigator) navigator.wakeLock.request("screen").catch(() => {});
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
  if (gyroActive && rawYaw !== null) {
    anchorHeading(displayYaw);
    updateSpin();
  }
  if (updateAutoShot(now, busy)) shoot();
  drawDome();
  if (!hasVFC) drawTargets(holdProgress);
  countFrame(now);
  requestAnimationFrame(renderLoop);
}

captureBtn.addEventListener("click", () => {
  if (busy || isDone()) return;

  // Recalibration: aimed back at the last photo, so no photo is taken.
  if (headingLost() && gyroActive && rawYaw !== null) {
    recalibrate(rawYaw);
    updateHUD();
    return;
  }
  shoot();
});

async function shoot() {
  busy = true;
  const rotation = captureRotation(); // the capture can take a second, and the phone moves on

  flash.classList.add("animate");
  setTimeout(() => flash.classList.remove("animate"), 180);

  captureBtn.disabled = true;
  let blob = null;
  try {
    blob = await capturePhoto();
  } catch (_) {}
  captureBtn.disabled = false;
  busy = false;

  if (!blob) {
    shotFailed();
    setPrompt("Frame dropped - tap again.");
    return;
  }

  // Size from the blob directly - no createImageBitmap (that bitmap leaked memory on iOS).
  showShot(blob.size);
  savePhoto(shotTaken(blob, rotation, shotFov));
  updateHUD();
}

exportBtn.addEventListener("click", async () => {
  const label = exportBtn.textContent;
  exportBtn.disabled = true;
  exportBtn.textContent = "Packing…";
  try {
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
      });
    }

    const doc = {
      format: "guided-360-capture/v1",
      generated: new Date().toISOString(),
      shotLayout: { tiltDegrees: LEVEL_TARGETS, shotsPerLevel: LEVEL_SHOTS },
      fovSource: fovSources.size === 1 ? [...fovSources][0] : "mixed",
      conventions: {
        rotation: "yaw/clkwise-from-level-reference, pitch above horizon, roll about the optical axis, all degrees",
        matrix: "row-major 3x3 device-to-world; world X east, Y north, Z up; camera axis is device -Z",
        fov: "rectilinear degrees; horizontal across width, vertical across height, for the stored orientation",
      },
      photos: entries,
    };
    files.push({ name: "metadata.json", blob: new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }) });

    const content = await buildZip(files);
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "360_photos.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportBtn.textContent = "Downloaded!";
  } catch (err) {
    alert("Failed to build ZIP: " + err.message);
    exportBtn.disabled = false;
    exportBtn.textContent = label;
  }
});
