import { LEVEL_TARGETS, LEVEL_SHOTS, currentLevel, currentShot, levelStartYaw, headingLost, isDone, shotHeading } from "./session.js";
import { DEG, gyroActive, rawRotation } from "./orientation.js";
import { ASSUMED_HFOV } from "./fov.js";
import { domeInk } from "./dome.js";

// World-locked targets: each shot of the level drawn where it sits in the scene, from
// the raw orientation (no smoothing, it would trail the image). The browser does not
// report the camera's field of view, so it assumes a typical phone main camera.
const targets = document.getElementById("targets");
const targetsCtx = targets.getContext("2d");
let targetsW = 0, targetsH = 0, targetsScale = 1;

export function initTargets() {
  targetsScale = Math.min(window.devicePixelRatio || 1, 2); // 3x adds memory, not visible detail
  targetsW = targets.clientWidth;
  targetsH = targets.clientHeight;
  // Resize only when the size changes (realloc leaks on iOS).
  const w = Math.round(targetsW * targetsScale), h = Math.round(targetsH * targetsScale);
  if (targets.width !== w) targets.width = w;
  if (targets.height !== h) targets.height = h;
}

function projectTarget(m, heading, pitch, f, cx, cy) {
  const cp = Math.cos(pitch * DEG);
  const w0 = cp * Math.sin(heading * DEG), w1 = cp * Math.cos(heading * DEG), w2 = Math.sin(pitch * DEG);
  // world -> device is the transpose
  const x = m[0] * w0 + m[3] * w1 + m[6] * w2;
  const y = m[1] * w0 + m[4] * w1 + m[7] * w2;
  const z = m[2] * w0 + m[5] * w1 + m[8] * w2;
  if (z > -0.1) return null; // behind the camera, or too far off-axis to place
  return { x: cx + f * x / -z, y: cy - f * y / -z };
}

function targetDot(x, y, r, color) {
  targetsCtx.beginPath();
  targetsCtx.arc(x, y, r, 0, Math.PI * 2);
  targetsCtx.fillStyle = color;
  targetsCtx.fill();
  targetsCtx.lineWidth = 1.5;
  targetsCtx.strokeStyle = "rgba(0,0,0,0.55)";
  targetsCtx.stroke();
}

function targetRing(x, y, r, color, sweep = 1) {
  targetsCtx.beginPath();
  targetsCtx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + sweep * Math.PI * 2);
  targetsCtx.lineWidth = 4;
  targetsCtx.strokeStyle = "rgba(0,0,0,0.55)";
  targetsCtx.stroke();
  targetsCtx.lineWidth = 2;
  targetsCtx.strokeStyle = color;
  targetsCtx.stroke();
}

export function drawTargets(holdProgress) {
  if (!targetsW) return; // capture screen not laid out yet
  targetsCtx.setTransform(targetsScale, 0, 0, targetsScale, 0, 0);
  targetsCtx.clearRect(0, 0, targetsW, targetsH);

  const m = rawRotation;
  if (!gyroActive || !m || headingLost() || levelStartYaw === null || isDone()) return;

  const cx = targetsW / 2, cy = targetsH / 2;
  const f = cx / Math.tan(ASSUMED_HFOV * DEG / 2);
  for (let i = 0; i < LEVEL_SHOTS[currentLevel]; i++) {
    const p = projectTarget(m, shotHeading(i), LEVEL_TARGETS[currentLevel], f, cx, cy);
    if (!p) continue;
    if (i === currentShot) {
      targetRing(p.x, p.y, 14, domeInk.ok);
      targetDot(p.x, p.y, 3, domeInk.ok);
    } else {
      targetDot(p.x, p.y, 5, i < currentShot ? domeInk.accent : "#fff");
    }
  }
  targetRing(cx, cy, 6, "#fff"); // aim point
  if (holdProgress > 0) targetRing(cx, cy, 20, domeInk.ok, holdProgress);
}
