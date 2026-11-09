import { LEVEL_TARGETS, LEVEL_SHOTS, currentLevel, currentShot, levelStartYaw, headingLost, isDone, shotHeading } from "./session.js";
import { DEG, gyroActive, rawRotation, rawYaw } from "./orientation.js";
import { ASSUMED_HFOV } from "./fov.js";
import { domeInk } from "./dome.js";

// World-locked targets: each shot of the level drawn where it sits in the scene, from
// the raw orientation (no smoothing, it would trail the image). The browser does not
// report the camera's field of view, so it assumes a typical phone main camera.
const targets = document.getElementById("targets");
const targetsCtx = targets.getContext("2d");
let targetsW = 0, targetsH = 0, targetsScale = 1;
const ARROW_TIP = 48, ARROW_LEN = 20, ARROW_HALF = 11; // px, out from the aim point

export function initTargets() {
  targetsScale = Math.min(window.devicePixelRatio || 1, 2); // 3x adds memory, not visible detail
  targetsW = targets.clientWidth;
  targetsH = targets.clientHeight;
  // Resize only when the size changes (realloc leaks on iOS).
  const w = Math.round(targetsW * targetsScale), h = Math.round(targetsH * targetsScale);
  if (targets.width !== w) targets.width = w;
  if (targets.height !== h) targets.height = h;
}

function toDevice(m, heading, pitch) {
  const cp = Math.cos(pitch * DEG);
  const w0 = cp * Math.sin(heading * DEG), w1 = cp * Math.cos(heading * DEG), w2 = Math.sin(pitch * DEG);
  // world -> device is the transpose
  return [
    m[0] * w0 + m[3] * w1 + m[6] * w2,
    m[1] * w0 + m[4] * w1 + m[7] * w2,
    m[2] * w0 + m[5] * w1 + m[8] * w2,
  ];
}

function projectTarget(m, heading, pitch, f, cx, cy) {
  const [x, y, z] = toDevice(m, heading, pitch);
  if (z > -0.1) return null; // behind the camera, or too far off-axis to place
  return { x: cx + f * x / -z, y: cy - f * y / -z };
}

// Points from the aim point towards the target, even one behind the camera. Hidden once
// the target's ring is close enough to run into it.
function targetArrow(m, heading, pitch, f, cx, cy) {
  const [x, y, z] = toDevice(m, heading, pitch);
  if (z <= -0.1 && f * Math.hypot(x, y) / -z < ARROW_TIP + 14) return;
  targetsCtx.save();
  targetsCtx.translate(cx, cy);
  targetsCtx.rotate(Math.atan2(-y, x));
  targetsCtx.beginPath();
  targetsCtx.moveTo(ARROW_TIP, 0);
  targetsCtx.lineTo(ARROW_TIP - ARROW_LEN, -ARROW_HALF);
  targetsCtx.lineTo(ARROW_TIP - ARROW_LEN * 0.7, 0);
  targetsCtx.lineTo(ARROW_TIP - ARROW_LEN, ARROW_HALF);
  targetsCtx.closePath();
  targetsCtx.fillStyle = domeInk.ok;
  targetsCtx.fill();
  targetsCtx.lineWidth = 1.5;
  targetsCtx.strokeStyle = "rgba(0,0,0,0.55)";
  targetsCtx.stroke();
  targetsCtx.restore();
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
  if (!gyroActive || !m || isDone()) return;

  const cx = targetsW / 2, cy = targetsH / 2;
  const f = cx / Math.tan(ASSUMED_HFOV * DEG / 2);
  const known = !headingLost() && levelStartYaw !== null;
  for (let i = 0; known && i < LEVEL_SHOTS[currentLevel]; i++) {
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
  // Heading lost: only the tilt is known, so the arrow keeps the heading the camera has.
  targetArrow(m, known ? shotHeading(currentShot) : rawYaw, LEVEL_TARGETS[currentLevel], f, cx, cy);
}
