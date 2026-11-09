import { LEVEL_SHOTS, currentLevel, headingLost, isDone, spinTarget } from "./session.js";
import { gyroActive, displayYaw, rawRotation, angleDiff, rotationAngle } from "./orientation.js";
import { tiltAligned, YAW_TOLERANCE } from "./hud.js";

// Aimed at the target and held still this long, the photo takes itself.
const HOLD_MS = 800;
const STILL_DEG = 3; // the aim may wander this far during the hold: hand tremor, not a pan

let holdSince = null;
let holdAnchor = null; // rotation when the hold started
export let holdProgress = 0; // 0..1

// The poles have no heading, so only their tilt counts.
function aimedAtTarget() {
  if (!tiltAligned) return false;
  if (LEVEL_SHOTS[currentLevel] === 1) return true;
  const target = spinTarget();
  return target !== null && displayYaw !== null && Math.abs(angleDiff(displayYaw, target)) <= YAW_TOLERANCE;
}

// Fills the ring around the aim point while aimed; it restarts when the aim drifts past
// STILL_DEG from where the hold began. Hand tremor is fast but goes nowhere, so the hold
// is judged by drift, not speed. True once the hold is complete.
export function updateAutoShot(now, busy) {
  const armed = gyroActive && !busy && !headingLost() && !isDone()
      && rawRotation !== null && aimedAtTarget();
  if (!armed) {
    holdSince = null;
    holdProgress = 0;
    return false;
  }
  if (holdSince === null || rotationAngle(holdAnchor, rawRotation) > STILL_DEG) {
    holdSince = now;
    holdAnchor = rawRotation;
  }
  holdProgress = Math.min(1, (now - holdSince) / HOLD_MS);
  if (holdProgress < 1) return false;
  holdSince = null;
  holdProgress = 0;
  if (navigator.vibrate) navigator.vibrate(30);
  return true;
}
