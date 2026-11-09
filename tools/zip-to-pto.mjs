#!/usr/bin/env node
// Reads a guided-360-capture .zip (metadata.json + the JPEGs) and writes a Hugin
// project next to it, extracting the photos so the project opens straight away.
//
//   node tools/zip-to-pto.mjs 360_photos.zip
//   node tools/zip-to-pto.mjs 360_photos.zip -o pano.pto --width 12000
//
// The generated pto carries the measured yaw/pitch/roll and the lens FOV, so Hugin
// starts from the real pose. It still has no control points: let Hugin detect them
// (Align), then Optimize, then Stitch.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { buildPto } from "../js/pto.js";
import { fovFromFocal, parseExif } from "../js/fov.js";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const usage = () => {
  console.log(`Usage: node tools/zip-to-pto.mjs <capture.zip> [options]

Options:
  -o, --out <file>   output .pto (default: <zip name>.pto next to the zip)
      --width <px>   output panorama width (default: 8000; height = width / 2)
      --height <px>  output panorama height
      --no-extract   write the .pto only; unzip the archive yourself
  -h, --help         show this help

Photos are extracted next to the .pto (existing files are left alone), because the
project refers to them with relative paths.`);
};

function findEndOfCentralDirectory(buf) {
  if (buf.length < 22) throw new Error("not a zip file (too short)");
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip file (no end-of-central-directory record)");
}

function readZip(path) {
  const buf = readFileSync(path);
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error("corrupt zip central directory");
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`corrupt zip entry: ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    entries.push({ name, method, compressedSize, size, dataStart, cached: null });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function entryData(zip, entry) {
  if (entry.cached) return entry.cached;
  if (entry.size === 0) return Buffer.alloc(0);
  const raw = zip.buf.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let data;
  if (entry.method === 0) data = raw; // stored; our own exports use this
  else if (entry.method === 8) data = inflateRawSync(raw); // re-zipped with deflate
  else throw new Error(`${entry.name}: unsupported zip compression method ${entry.method}`);
  if (entry.method !== 0) entry.cached = data;
  return data;
}

// First SOF header gives the stored pixel size; APP1 gives EXIF orientation.
function probeJpeg(data) {
  let width = 0, height = 0;
  const end = Math.min(data.length, 262144);
  if (data.length > 4 && data[0] === 0xFF && data[1] === 0xD8) {
    let i = 2;
    while (i + 9 < end) {
      if (data[i] !== 0xFF) { i++; continue; }
      const marker = data[i + 1];
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) break;
      const len = (data[i + 2] << 8) | data[i + 3];
      if (len < 2) break;
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        height = (data[i + 5] << 8) | data[i + 6];
        width = (data[i + 7] << 8) | data[i + 8];
        break;
      }
      i += 2 + len;
    }
  }
  const tags = parseExif(data.subarray(0, Math.min(data.length, 262144)));
  // null when the file carries no EXIF at all, so metadata's orientation is used
  // (canvas JPEGs have none and are already upright).
  return {
    width,
    height,
    orientation: tags ? (tags.orientation || 1) : null,
    focal35mm: (tags && tags.focal35mm) || null,
  };
}

function findMetadata(entries) {
  const candidates = entries.filter((e) => /(^|\/)metadata\.json$/i.test(e.name));
  if (!candidates.length) throw new Error("no metadata.json in the archive (is this a guided-360-capture zip?)");
  return candidates.sort((a, b) => a.name.length - b.name.length)[0];
}

function resolveImage(entries, entryFile) {
  const file = entryFile.replace(/\\/g, "/").replace(/^\.\//, "");
  let hit = entries.find((e) => e.name === file);
  if (!hit) hit = entries.find((e) => e.name.endsWith("/" + file) || file.endsWith("/" + e.name));
  if (!hit) {
    const base = file.split("/").pop();
    hit = entries.find((e) => e.name.split("/").pop() === base);
  }
  return hit;
}

function safeDestination(root, name) {
  const rootAbs = resolve(root);
  const dest = resolve(rootAbs, name);
  if (dest !== rootAbs && !dest.startsWith(rootAbs + sep)) return null;
  return dest;
}

function parseArgs(argv) {
  const opts = { extract: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { usage(); process.exit(0); }
    else if (a === "-o" || a === "--out") {
      opts.out = argv[++i];
      if (!opts.out) throw new Error(`${a} needs a file name`);
    }
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--no-extract") opts.extract = false;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (!opts.zip) opts.zip = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!opts.zip) { usage(); process.exit(1); }
  if (opts.width !== undefined && !(opts.width > 0)) throw new Error("--width must be positive");
  if (opts.height !== undefined && !(opts.height > 0)) throw new Error("--height must be positive");
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const zipPath = resolve(opts.zip);
  if (!existsSync(zipPath) || !statSync(zipPath).isFile()) throw new Error(`no such file: ${zipPath}`);

  const zip = readZip(zipPath);
  const metaEntry = findMetadata(zip.entries);
  let doc;
  try {
    doc = JSON.parse(entryData(zip, metaEntry).toString("utf8"));
  } catch (err) {
    throw new Error(`${metaEntry.name} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(doc.photos) || !doc.photos.length) throw new Error(`${metaEntry.name} has no photos`);

  const outPto = resolve(opts.out
      ? opts.out
      : join(dirname(zipPath), basename(zipPath, extname(zipPath)) + ".pto"));
  const outDir = dirname(outPto);

  // Pair every metadata entry with the archive entry that holds its JPEG.
  const files = new Map(); // doc file -> zip entry
  const sizes = {};
  const missing = [];
  doc.photos.forEach((photo, i) => {
    if (!photo.file) throw new Error(`${metaEntry.name}: photo ${i + 1} has no file field`);
  });
  for (const photo of doc.photos) {
    const entry = resolveImage(zip.entries, photo.file);
    if (!entry) { missing.push(photo.file); continue; }
    files.set(photo.file, entry);
    const probe = probeJpeg(entryData(zip, entry));
    sizes[photo.file] = probe;

    // Set exported before fov.width/height existed: recover the lens from EXIF.
    if (!photo.fov || !Number.isFinite(photo.fov.horizontal)) {
      const orientation = probe.orientation ?? (photo.fov && photo.fov.orientation) ?? 1;
      const rotated = orientation === 6 || orientation === 8;
      const upW = rotated ? probe.height : probe.width;
      const upH = rotated ? probe.width : probe.height;
      if (probe.focal35mm && upW > 0 && upH > 0) {
        photo.fov = {
          ...fovFromFocal(probe.focal35mm, upW, upH),
          width: upW,
          height: upH,
          orientation,
        };
      }
    }
  }
  if (missing.length) {
    throw new Error(`the archive is missing ${missing.length} photo(s):\n  ${missing.join("\n  ")}`);
  }

  const pto = buildPto(doc, {
    width: opts.width,
    height: opts.height,
    sizes,
    input: basename(zipPath),
    pathFor: (file) => (files.get(file) || { name: file }).name,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPto, pto, "utf8");

  let extracted = 0, skipped = 0, refused = 0;
  if (opts.extract) {
    for (const photo of doc.photos) {
      const entry = files.get(photo.file);
      const dest = safeDestination(outDir, entry.name);
      if (!dest) { refused++; continue; }
      if (existsSync(dest)) { skipped++; continue; }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entryData(zip, entry));
      extracted++;
    }
  }

  console.log(`Read ${doc.photos.length} photos from ${basename(zipPath)}`);
  console.log(`Wrote ${outPto}`);
  if (opts.extract) {
    console.log(`Extracted ${extracted} photo(s) to ${outDir}` +
        (skipped ? `, ${skipped} already existed` : "") +
        (refused ? `, ${refused} refused (unsafe path)` : ""));
  } else {
    console.log("Photos not extracted: unzip the archive next to the .pto so its relative paths resolve.");
  }
  console.log("Open the .pto in Hugin, then Align (control points) -> Optimize -> Stitch.");
}

try {
  main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
