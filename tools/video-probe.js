// Experimental spike: follow the normal target guidance, but record one video clip per
// level instead of taking stills, and mark the instant each target was aimed. The zip
// that comes out is meant for a server-side ffmpeg pass that picks a sharp frame near
// each marker. Nothing here is wired into the main capture flow.
import {
  LEVEL_TARGETS, LEVEL_SHOTS, photos, currentLevel, currentShot,
  isDone, resetSession, shotTaken, undoShot, anchorHeading,
} from "../js/session.js";
import {
  gyroActive, gotOrientation, rawPitch, rawYaw, displayPitch, displayYaw,
  requestGyro, startOrientation, stopOrientation, smoothOrientation, captureRotation,
} from "../js/orientation.js";
import { startCamera, stopCamera } from "../js/camera.js";
import { initDome, drawDome } from "../js/dome.js";
import { initTargets, drawTargets } from "../js/targets.js";
import { updateTilt, updateHUD, updatePerf, countFrame, setPrompt } from "../js/hud.js";
import { holdProgress, updateAutoShot } from "../js/autoshot.js";
import { buildZip } from "../js/zip.js";
import { describeDevice } from "../js/device.js";

const $ = (id) => document.getElementById(id);
const intro = $("intro"), capture = $("capture"), errorEl = $("error");
const startBtn = $("start-btn"), resSel = $("res"), stopBtn = $("stop-btn");
const exportBtn = $("export-btn"), stitchBtn = $("stitch-btn"), undoBtn = $("undo-btn");
const statusEl = $("probe-status"), video = $("video");

const BITRATE = Number(new URLSearchParams(location.search).get("bitrate")) || 8_000_000;
const MIMES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];
const rnd = (v) => Math.round((v || 0) * 100) / 100;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

let running = false, busy = false, finished = false;
let clips = [], markers = [];
let current = null;          // { id, level, rec, chunks, poses, start, ... }
let clipSeq = 0;
let clipChain = Promise.resolve();
let lastLevel = -1;
let statusAt = 0;
let packing = false;

startBtn.addEventListener("click", begin);
stopBtn.addEventListener("click", stopAndDownload);
exportBtn.addEventListener("click", downloadProbe);

undoBtn.addEventListener("click", () => {
  if (busy || !photos.length) return;
  undoShot();
  markers.pop();
  refreshHUD();
  setPrompt("Marker removed.");
});

function pickMime() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const m of MIMES) if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function begin() {
  errorEl.classList.add("hidden");
  startBtn.disabled = true;

  // iOS grants orientation inside the tap.
  await requestGyro();

  resetSession();
  clips = []; markers = []; current = null;
  clipSeq = 0;
  lastLevel = -1; finished = false; packing = false;
  clipChain = Promise.resolve();

  const res = resSel.value;
  const forVideo = res === "2160" ? { width: 3840, height: 2160 }
      : res === "1080" ? { width: 1920, height: 1080 } : null;
  try {
    await startCamera(forVideo ? { forVideo } : {});
  } catch (err) {
    errorEl.textContent = "Camera error: " + err.message + " (needs HTTPS)";
    errorEl.classList.remove("hidden");
    startBtn.disabled = false;
    return;
  }

  if (gyroActive) {
    startOrientation();
    setTimeout(() => {
      if (!gotOrientation) setPrompt("No motion sensor - markers still record, poses will be empty.");
    }, 2000);
  } else {
    setPrompt("No motion sensor - markers still record, poses will be empty.");
  }
  window.addEventListener("deviceorientation", logPose);

  intro.classList.replace("active", "hidden");
  capture.classList.replace("hidden", "active");

  running = true;
  initDome();
  initTargets();
  refreshHUD();
  updatePerf();
  requestAnimationFrame(loop);
}

function loop(now) {
  if (!running) return;
  smoothOrientation();
  if (gyroActive && rawPitch !== null) updateTilt(displayPitch);
  if (gyroActive && rawYaw !== null) anchorHeading(displayYaw);
  if (updateAutoShot(now, busy)) mark();
  drawDome();
  drawTargets(holdProgress);
  countFrame(now);
  syncClip();
  updateStatus(now);
  requestAnimationFrame(loop);
}

// Reuse the auto-shot hold as a marker: no still is taken, the session just advances so
// the next target appears, and the time is recorded against the level's clip.
function mark() {
  const level = currentLevel, shot = currentShot;
  const clip = current && current.level === level ? current : null;
  const t = clip ? Math.round(performance.now() - clip.start) : null;
  const rotation = captureRotation();

  shotTaken(null, rotation, null, null, false);
  markers.push({ level: level + 1, shot: shot + 1, t, rotation, clipId: clip ? clip.id : null });
  refreshHUD();
  if (isDone()) setPrompt("All targets marked - download the probe.");
}

function syncClip() {
  if (finished) return;
  if (isDone()) {
    finished = true;
    lastLevel = -2;
    queueClip(null);
    return;
  }
  if (currentLevel !== lastLevel) {
    lastLevel = currentLevel;
    queueClip(currentLevel);
  }
}

function queueClip(level) {
  clipChain = clipChain
    .then(async () => {
      await stopClip();
      if (level === null || level >= LEVEL_TARGETS.length) return;
      await wait(200); // some devices dislike an immediate restart on the same track
      startClip(level);
    })
    .catch((err) => setStatus("clip error: " + err.message));
}

function startClip(level) {
  const stream = video.srcObject;
  if (!stream || typeof MediaRecorder === "undefined") {
    setStatus("MediaRecorder unavailable");
    return;
  }
  const mime = pickMime();
  let rec;
  try {
    rec = new MediaRecorder(stream, mime
        ? { mimeType: mime, videoBitsPerSecond: BITRATE }
        : { videoBitsPerSecond: BITRATE });
  } catch (err) {
    setStatus("Recorder failed: " + err.message);
    return;
  }

  const clip = {
    id: ++clipSeq,
    level, rec, chunks: [], poses: [], start: performance.now(),
    mimeType: rec.mimeType || mime || "", stopResolve: null,
  };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) clip.chunks.push(e.data); };
  rec.onerror = (e) => setStatus("Recorder error: " + ((e.error && e.error.message) || ""));
  rec.onstop = () => {
    const s = stream.getVideoTracks()[0].getSettings();
    clip.blob = new Blob(clip.chunks, { type: clip.mimeType || "video/webm" });
    clip.chunks.length = 0;
    clip.width = s.width;
    clip.height = s.height;
    clip.duration = performance.now() - clip.start;
    clips.push(clip);
    current = null;
    updateStatus(performance.now());
    if (clip.stopResolve) { clip.stopResolve(); clip.stopResolve = null; }
  };

  // start(1000): the timeslice dodges the iOS MP4 stall and bounds how much one lost
  // fragment can cost.
  try {
    rec.start(1000);
  } catch (err) {
    setStatus("Recorder failed: " + err.message);
    return;
  }
  current = clip;
  updateStatus(performance.now());
}

function stopClip() {
  const clip = current;
  if (!clip) return Promise.resolve();
  return new Promise((resolve) => {
    if (clip.rec.state === "inactive") { resolve(); return; }
    clip.stopResolve = resolve;
    try { clip.rec.stop(); } catch (_) { resolve(); }
  });
}

function logPose(e) {
  if (!current || current.rec.state !== "recording" || e.alpha == null) return;
  current.poses.push([
    Math.round(performance.now() - current.start),
    rnd(e.alpha), rnd(e.beta), rnd(e.gamma),
  ]);
}

function refreshHUD() {
  updateHUD();
  stitchBtn.classList.add("hidden");
  undoBtn.textContent = "Undo marker";
  if (isDone()) exportBtn.textContent = "Download probe (.zip)";
}

function updateStatus(now) {
  if (now - statusAt < 300) return;
  statusAt = now;
  const s = video.srcObject ? video.srcObject.getVideoTracks()[0].getSettings() : {};
  const mime = (current && current.rec.mimeType)
      || (clips.length && clips[clips.length - 1].mimeType)
      || pickMime() || "?";
  const bytes = clips.reduce((n, c) => n + (c.blob ? c.blob.size : 0), 0);
  statusEl.textContent = `${current ? "REC" : "idle"} · clips ${clips.length}`
      + ` · ${s.width || "?"}×${s.height || "?"}`
      + ` · ${mime} · ${(BITRATE / 1e6).toFixed(1)} Mbps`
      + ` · ${(bytes / 1048576).toFixed(1)} MB`
      + ` · poses ${current ? current.poses.length : 0}`;
}

async function stopAndDownload() {
  if (!running) return;
  running = false;
  stopOrientation();
  window.removeEventListener("deviceorientation", logPose);
  stopBtn.disabled = true;
  await downloadProbe();
  stopCamera();
}

async function downloadProbe() {
  if (packing) return;
  packing = true;
  finished = true;
  const label = exportBtn.textContent;
  exportBtn.disabled = true;
  exportBtn.textContent = "Packing…";
  try {
    await clipChain;
    await stopClip();
    if (!clips.length) throw new Error("no clips recorded");

    const files = [];
    const clipEntries = [];
    for (const c of clips) {
      if (!c.blob) continue;
      const ext = /mp4/i.test(c.mimeType || "") ? "mp4" : "webm";
      const name = `video/level_${String(c.level + 1).padStart(2, "0")}_clip${String(c.id).padStart(2, "0")}.${ext}`;
      files.push({ name, blob: c.blob });
      clipEntries.push({
        id: c.id,
        level: c.level + 1,
        file: name,
        mimeType: c.mimeType,
        width: c.width || null,
        height: c.height || null,
        durationMs: Math.round(c.duration || 0),
        bytes: c.blob.size,
        markers: markers.filter((m) => m.clipId === c.id),
        poses: c.poses,
      });
    }
    const loose = markers.filter((m) => m.clipId == null);

    const doc = {
      format: "guided-360-video-probe/v1",
      generated: new Date().toISOString(),
      device: await describeDevice(),
      capture: {
        mode: "video",
        bitrate: BITRATE,
        timesliceMs: 1000,
        cropNote: "the 3:4 portrait preview is a centred crop of the recorded frame; a 16:9 request records the full sensor width and the server should crop 3:4 before stitching.",
        poseLog: "deviceorientation events, [ms since clip start, alpha, beta, gamma]",
        markerNote: "t is ms from the start of that level's clip; null means the marker landed between clips. The first encoded frame may arrive ~50-160 ms after start, so search around t on the server.",
      },
      shotLayout: { tiltDegrees: LEVEL_TARGETS, shotsPerLevel: LEVEL_SHOTS },
      totalMarkers: markers.length,
      looseMarkers: loose,
      clips: clipEntries,
    };
    files.push({
      name: "video/metadata.json",
      blob: new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    });

    const zip = await buildZip(files);
    const url = URL.createObjectURL(zip);
    const a = document.createElement("a");
    a.href = url;
    a.download = "video_probe.zip";
    a.click();
    exportBtn.textContent = "Downloaded!";
    exportBtn.disabled = false;
  } catch (err) {
    alert("Failed to build probe: " + err.message);
    exportBtn.disabled = false;
    exportBtn.textContent = label;
  } finally {
    packing = false;
  }
}
