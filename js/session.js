import { normDeg, ROTATION_SIGN } from "./orientation.js";

export const LEVEL_TARGETS = [90, 45, 0, -45, -90];
export const LEVEL_SHOTS = [1, 10, 16, 10, 1];
export const shotsBefore = (level) => LEVEL_SHOTS.slice(0, level).reduce((a, b) => a + b, 0);
export const TOTAL_SHOTS = shotsBefore(LEVEL_SHOTS.length);

export let currentLevel = 0;
export let currentShot = 0;
export const photos = [];
export let levelStartYaw = null; // heading where shot 0 of the current level sits
export let refShot = 0;          // > 0: heading lost at this shot

export const headingLost = () => refShot > 0 && currentShot === refShot;
export const isDone = () => currentLevel >= LEVEL_TARGETS.length;
export const yawStep = () => 360 / LEVEL_SHOTS[currentLevel];
export const shotHeading = (i) => levelStartYaw + ROTATION_SIGN * yawStep() * i;

// Measured from the start of the level, not the previous shot, so one overshoot
// doesn't drag the rest of the level's targets along with it.
export function spinTarget() {
  return levelStartYaw === null ? null : shotHeading(currentShot);
}

export function resetSession() {
  photos.length = 0;
  currentLevel = currentShot = refShot = 0;
}

export function restoreSession(n) {
  for (let i = 0; i < n; i++) {
    photos.push({ level: currentLevel, shot: currentShot, blob: null });
    if (++currentShot === LEVEL_SHOTS[currentLevel]) { currentShot = 0; currentLevel++; }
  }
  // The heading reference died with the old page (iOS alpha has no fixed zero across
  // loads), so the first tap after a resume recalibrates it.
  refShot = currentShot;
}

export function anchorHeading(yaw) {
  if (levelStartYaw === null) levelStartYaw = normDeg(yaw - ROTATION_SIGN * yawStep() * currentShot);
}

// A capture in flight still lands, so the tap after it is the one that recalibrates.
export function loseHeading(inFlight) {
  refShot = inFlight ? currentShot + 1 : currentShot;
  levelStartYaw = null;
}

export function recalibrate(yaw) {
  levelStartYaw = normDeg(yaw - ROTATION_SIGN * yawStep() * (currentShot - 1));
  refShot = 0;
}

export function shotFailed() {
  if (refShot > currentShot) refShot = currentShot; // hidden mid-capture: recalibrate now
}

export function shotTaken(blob, rotation, fov) {
  const target = {
    pitch: LEVEL_TARGETS[currentLevel],
    heading: LEVEL_SHOTS[currentLevel] > 1 && levelStartYaw !== null
        ? normDeg(shotHeading(currentShot)) : null,
  };
  const entry = { level: currentLevel, shot: currentShot, blob, rotation: rotation || null, fov: fov || null, target };
  photos.push(entry);

  // The reference shot re-zeroes the heading (stored as where shot 0 sits), so drift
  // only builds up within one level (~1 min), never across the whole run. Not at the
  // poles: a vertical camera axis has no heading.
  const tapYaw = rotation ? rotation.yaw : null;
  if (currentShot === refShot && tapYaw !== null && LEVEL_SHOTS[currentLevel] > 1) {
    levelStartYaw = normDeg(tapYaw - ROTATION_SIGN * yawStep() * currentShot);
  }

  currentShot++;
  if (currentShot >= LEVEL_SHOTS[currentLevel]) {
    currentShot = 0;
    currentLevel++;
    refShot = 0;
  }
  return entry;
}
