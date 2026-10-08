export const DEG = Math.PI / 180;
export const ROTATION_SIGN = 1; // flip to -1 if "rotate right" drives the bubble away from the centre
const SMOOTHING = 0.18;

export let gyroActive = false;
export let gotOrientation = false;
export let rawPitch = null;
export let displayPitch = null;
export let rawYaw = null;
export let displayYaw = null;
export let rawRotation = null; // device rotation matrix from the latest orientation event

export function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

// Shortest signed distance from b to a, in [-180, 180). Plain subtraction would turn
// the 359 -> 1 wrap into a 358 degree jump.
export function angleDiff(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

// R = Rz(a)Rx(b)Ry(g), row-major: device to world coords (X east, Y north, Z up).
export function deviceRotation(alpha, beta, gamma) {
  const cA = Math.cos(alpha * DEG), sA = Math.sin(alpha * DEG);
  const cB = Math.cos(beta * DEG), sB = Math.sin(beta * DEG);
  const cG = Math.cos(gamma * DEG), sG = Math.sin(gamma * DEG);
  return [
    cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
    sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
    -cB * sG, sB, cB * cG,
  ];
}

// Never read e.alpha directly: deviceorientation is Euler ZXY, and alpha/gamma go
// degenerate at beta = +-90 - exactly the 0 degree level, with the phone upright.
// The azimuth of the rear camera axis (device -z) in R stays stable there: the
// alpha/gamma noise cancels out. Only the single-shot +-90 levels point the axis
// vertical, where it has no azimuth, and they never re-zero the heading.
function cameraHeading(m) {
  // third column of R: the device +z axis in world coords
  return normDeg(Math.atan2(-m[2], -m[5]) / DEG);
}

// Angle between two rotations: cos = (trace(A^T B) - 1) / 2.
export function rotationAngle(a, b) {
  let dot = 0;
  for (let k = 0; k < 9; k++) dot += a[k] * b[k];
  return Math.acos(Math.max(-1, Math.min(1, (dot - 1) / 2))) / DEG;
}

export async function requestGyro() {
  gyroActive = await permission();
}

async function permission() {
  if (typeof DeviceOrientationEvent === "undefined") return false;
  if (typeof DeviceOrientationEvent.requestPermission !== "function") return true;
  try {
    return (await DeviceOrientationEvent.requestPermission()) === "granted";
  } catch (_) {
    return false;
  }
}

export function startOrientation() {
  window.addEventListener("deviceorientation", handleOrientation);
}

export function stopOrientation() {
  gyroActive = false;
  window.removeEventListener("deviceorientation", handleOrientation);
}

export function forgetHeading() {
  rawYaw = displayYaw = rawRotation = null;
}

function handleOrientation(e) {
  if (e.beta == null) return;
  gotOrientation = true;
  // Elevation of the camera axis. Beta alone won't do: it wraps from +180 to -180 at the zenith.
  rawPitch = Math.asin(-Math.cos(e.beta * DEG) * Math.cos((e.gamma || 0) * DEG)) / DEG;
  if (e.alpha == null || e.gamma == null) return;
  rawRotation = deviceRotation(e.alpha, e.beta, e.gamma);
  rawYaw = cameraHeading(rawRotation);
}

const round4 = (v) => Math.round(v * 10000) / 10000;

export function captureRotation() {
  if (rawRotation === null || rawYaw === null || rawPitch === null) return null;
  const m = rawRotation;
  const fx = -m[2], fy = -m[5], fz = -m[8];
  const wx = -fz * fx, wy = -fz * fy, wz = 1 - fz * fz;
  const udotf = m[1] * fx + m[4] * fy + m[7] * fz;
  const ux = m[1] - udotf * fx, uy = m[4] - udotf * fy, uz = m[7] - udotf * fz;
  const rdotf = m[0] * fx + m[3] * fy + m[6] * fz;
  const rx = m[0] - rdotf * fx, ry = m[3] - rdotf * fy, rz = m[6] - rdotf * fz;
  const roll = Math.atan2(wx * rx + wy * ry + wz * rz, wx * ux + wy * uy + wz * uz) / DEG;
  return { yaw: round4(rawYaw), pitch: round4(rawPitch), roll: round4(roll), matrix: m.map(round4) };
}

export function smoothOrientation() {
  if (!gyroActive) return;
  if (rawPitch !== null) {
    displayPitch = (displayPitch === null)
        ? rawPitch
        : displayPitch + (rawPitch - displayPitch) * SMOOTHING;
  }
  if (rawYaw !== null) {
    // Same smoothing as the pitch, through angleDiff so it never unwinds at the wrap.
    displayYaw = (displayYaw === null)
        ? rawYaw
        : normDeg(displayYaw + angleDiff(rawYaw, displayYaw) * SMOOTHING);
  }
}
