// Builds a Hugin/PanoTools .pto project from the metadata.json written by the export.
//
// The point is to give Hugin the measured pose instead of a blank project, so the
// optimizer starts at the real pose instead of near the identity: yaw/pitch place
// the optical axis, roll levels the image, and v is the measured horizontal FOV.
//
// Conventions (verified against libpano13's SetMatrix/persp_sphere and Hugin's
// Image positioning model):
//   * Hugin yaw: positive places the image to the right. Our heading also grows
//     clockwise, so they are the same number.
//   * Hugin pitch: positive tilts the optical axis up. Same as our pitch.
//   * Hugin roll: positive rotates the image clockwise. Our roll is the opposite
//     (it is + when the camera top tilts left), hence the negation.
//   * EXIF orientation is an extra in-plane rotation of the *stored* pixels. Hugin
//     would add it itself when opening the JPEGs (orientation 6 -> roll 90), but a
//     pto's r value wins, so it has to be folded in here or landscape-stored stills
//     come out sideways.
//   * v is the HFOV across the stored pixel width. For a 6/8-oriented file the
//     stored width is the upright height, so the vertical FOV is the right value.

const DEG = Math.PI / 180;
export const DEFAULT_HFOV = 53; // same constant as fov.js/ASSUMED_HFOV
export const DEFAULT_PANO_WIDTH = 8000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmt = (v) => Number((num(v) ?? 0).toFixed(4)).toString();

// Keep angles readable: -180..180 rather than 0..360.
const norm180 = (deg) => {
  const d = ((deg % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
};

// Same mapping Hugin uses in SrcPanoImage::readEXIF.
const orientationRoll = (o) => (o === 3 ? 180 : o === 6 ? 90 : o === 8 ? 270 : 0);

// 6 and 8 store the long edge across, so the displayed size is the transposed one.
const storedIsRotated = (o) => o === 6 || o === 8;

// Stored pixel size + HFOV across that width. `sizes` (from the CLI, which reads the
// JPEG headers) wins over the metadata, so a zipped set that predates fov.width/
// height still works.
export function imageGeometry(entry, sizes = {}) {
  const fov = entry.fov || {};
  const probe = sizes[entry.file] || null;
  let orientation = num(probe && probe.orientation) ?? num(fov.orientation) ?? 1;
  if (![1, 3, 5, 6, 7, 8].includes(orientation)) orientation = 1;

  let rawW = num(probe && probe.width);
  let rawH = num(probe && probe.height);
  let upW = num(fov.width);
  let upH = num(fov.height);

  if (!rawW || !rawH) {
    if (!upW || !upH) {
      throw new Error(`no size for ${entry.file}: metadata has no fov.width/height and the JPEG header could not be read`);
    }
    rawW = storedIsRotated(orientation) ? upH : upW;
    rawH = storedIsRotated(orientation) ? upW : upH;
  } else {
    upW = storedIsRotated(orientation) ? rawH : rawW;
    upH = storedIsRotated(orientation) ? rawW : rawH;
  }

  // setShotFov uses 3x4 as its last-ditch placeholder when a size read failed;
  // don't turn that into a pto that claims the photo is 3 pixels wide.
  rawW = Math.round(rawW);
  rawH = Math.round(rawH);
  if (rawW < 16 || rawH < 16) {
    throw new Error(`implausible size for ${entry.file} (${rawW}x${rawH}); the JPEG header could not be read`);
  }

  // The metadata FOVs are for the displayed (upright) image: horizontal across
  // upW, vertical across upH.
  const hUp = num(fov.horizontal) ?? DEFAULT_HFOV;
  const vUp = num(fov.vertical)
      ?? 2 * Math.atan(Math.tan(hUp * DEG / 2) * (upH / upW)) / DEG;

  return {
    orientation,
    width: rawW,
    height: rawH,
    hfov: storedIsRotated(orientation) ? vUp : hUp,
  };
}

// Pose for the i-line: measured gyro pose when there is one, otherwise the ideal
// grid pose from the shot target (a no-sensor run).
export function imagePose(entry) {
  const rot = entry.rotation || {};
  const target = entry.target || {};
  const yaw = num(rot.yaw) ?? num(target.heading) ?? 0;
  const pitch = num(rot.pitch) ?? num(target.pitch) ?? 0;
  const roll = num(rot.roll) ?? 0; // our roll: positive = camera top tilts left
  return { yaw: norm180(yaw), pitch, roll };
}

// doc : parsed metadata.json
// opts.width/height : output pano size (equirectangular, 2:1 by default)
// opts.sizes : { [entry.file]: { width, height, orientation } } from the JPEG headers
// opts.pathFor : rewrites entry.file for the n"..." field (defaults to identity)
// opts.input : original file name shown in a comment
export function buildPto(doc, opts = {}) {
  const photos = doc && Array.isArray(doc.photos) ? doc.photos : [];
  if (!photos.length) throw new Error("metadata.json has no photos");

  const width = Math.max(2, Math.round(num(opts.width) ?? DEFAULT_PANO_WIDTH));
  const height = Math.max(1, Math.round(num(opts.height) ?? width / 2));
  const sizes = opts.sizes || {};
  const pathFor = typeof opts.pathFor === "function" ? opts.pathFor : (f) => f;
  const leaders = new Map(); // raw size + HFOV -> index of the lens's first image
  const noPose = photos.filter((p) => !p.rotation).length;

  const out = [
    "# hugin project file",
    "#hugin_ptoversion 2",
    "#",
    `# Generated by guided-360-capture${opts.input ? ` from ${opts.input}` : ""}${doc.generated ? `, captured ${doc.generated}` : ""}.`,
    `# ${photos.length} photos, ${doc.fovSource || "unknown"} FOV source.`,
    "# yaw/pitch are the optical axis; roll includes the JPEG EXIF orientation.",
    "# v and a..t are linked per (stored size, HFOV) group: one lens per group.",
  ];
  if (noPose) out.push(`# ${noPose} photo(s) had no gyro pose; grid targets were used instead.`);
  out.push(
    "",
    `p f2 w${width} h${height} v360  E0 R0 n"JPEG q95"`,
    "m g1 i0 f0 m2 p0.00784314",
    "",
    "# image lines",
  );

  photos.forEach((entry, i) => {
    const geo = imageGeometry(entry, sizes);
    const pose = imagePose(entry);
    const roll = norm180(orientationRoll(geo.orientation) - pose.roll);

    // Same lens (same stored shape and FOV): link the lens variables to the first
    // image that used it. Width/height/projection cannot be linked in a pto.
    const key = `${geo.width}x${geo.height}@${geo.hfov.toFixed(3)}`;
    const leader = leaders.get(key);
    const lens = leader === undefined
        ? `v${fmt(geo.hfov)} a0 b0 c0 d0 e0 g0 t0`
        : `v=${leader} a=${leader} b=${leader} c=${leader} d=${leader} e=${leader} g=${leader} t=${leader}`;
    if (leader === undefined) leaders.set(key, i);

    out.push("#-hugin cropFactor=1");
    out.push(`i w${geo.width} h${geo.height} f0 ${lens} y${fmt(pose.yaw)} p${fmt(pose.pitch)} r${fmt(roll)} n"${pathFor(entry.file, entry)}"`);
  });

  out.push("", "# variables to optimize (none preset; use the Optimize tab)", "v", "");
  return out.join("\n");
}
