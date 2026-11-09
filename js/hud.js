import { LEVEL_TARGETS, LEVEL_SHOTS, TOTAL_SHOTS, shotsBefore, currentLevel, currentShot, photos, yawStep, headingLost } from "./session.js";
import { gyroActive } from "./orientation.js";
import { hasVFC, frameSeq, previewLabel, exposureLabel, shotW, shotH } from "./camera.js";
import { drawDomeBase } from "./dome.js";

const TOLERANCE = 5;
// 6 degrees of slop still leaves the neighbours overlapping by over a third on a
// typical phone lens.
export const YAW_TOLERANCE = 6;

const $ = (id) => document.getElementById(id);
const progressFill = $("progress-fill");
const levelLabel = $("level-label"), shotCounter = $("shot-label");
const prompt = $("prompt");
const undoBtn = $("undo-btn"), exportBtn = $("export-btn"), stitchBtn = $("stitch-btn");
const perf = $("perf");

export let tiltAligned = false;
let shotLabel = "—", fpsText = "…";
let uiFrames = 0, fpsAt = 0, fpsSeq = 0;

export function updatePerf() {
  perf.textContent = "FPS " + fpsText + " · Preview " + previewLabel + " · Shot " + shotLabel + " · Exposure " + exposureLabel;
}

function fmtSize(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + "MB" : Math.round(bytes / 1024) + "KB";
}

export function showShot(bytes) {
  shotLabel = (shotW ? shotW + "×" + shotH + " " : "") + "(" + fmtSize(bytes) + ")";
  updatePerf();
}

export function countFrame(now) {
  uiFrames++;
  if (!fpsAt) fpsAt = now;
  if (now - fpsAt < 1000) return;
  fpsText = String(hasVFC ? frameSeq - fpsSeq : uiFrames);
  uiFrames = 0;
  fpsSeq = frameSeq;
  fpsAt = now;
  updatePerf();
}

export function setPrompt(text) {
  prompt.textContent = text;
}

export function updateTilt(pitch) {
  tiltAligned = Math.abs(pitch - LEVEL_TARGETS[currentLevel]) <= TOLERANCE;
}

export function updateHUD() {
  const done = shotsBefore(currentLevel) + currentShot;
  progressFill.style.width = (done / TOTAL_SHOTS) * 100 + "%";
  drawDomeBase();

  // Heading lost: the same button recalibrates instead.
  const recal = headingLost() && gyroActive;
  undoBtn.textContent = recal ? "Recalibrate" : "Undo last photo";
  undoBtn.classList.toggle("recal", recal);
  undoBtn.disabled = !recal && !photos.length;

  if (done >= TOTAL_SHOTS) {
    levelLabel.textContent = "Done";
    shotCounter.textContent = photos.length + " photos";
    prompt.textContent = "All set. Stitch the panorama or download the photos.";
    stitchBtn.classList.remove("hidden");
    exportBtn.classList.remove("hidden");
    return;
  }
  stitchBtn.classList.add("hidden");
  exportBtn.classList.add("hidden");

  const t = LEVEL_TARGETS[currentLevel];
  const tiltText = `${t > 0 ? "+" : ""}${t}°`;
  levelLabel.textContent = `Level ${currentLevel + 1} of ${LEVEL_TARGETS.length} (${tiltText})`;
  shotCounter.textContent = `Shot ${currentShot + 1} of ${LEVEL_SHOTS[currentLevel]}`;
  prompt.textContent = currentShot === 0
      ? (!gyroActive ? `Aim ~${tiltText} (no sensor)`
          : LEVEL_SHOTS[currentLevel] > 1 ? `Tilt to ${tiltText} and aim at the green ring`
          : `Tilt the phone to ${tiltText}`)
      : recal
      ? "Aim where your last photo was, then tap Recalibrate"
      : (gyroActive ? "Rotate right to the green ring" : `Rotate ~${yawStep()}° right (no sensor)`);
}
