import { shotsBefore, TOTAL_SHOTS } from "./session.js";

// Photos go to IndexedDB as they are taken, so a run is bounded by storage rather than
// RAM, and a tab Safari kills mid-run can resume. Without IndexedDB (some private
// modes), or when a write fails, the photo stays in RAM.
const STORE = "photos";
let db = null;

function openDB() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open("guided-360", 1); } catch (_) { return resolve(null); }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
}

// Resolves when the transaction commits, so a write is only trusted once it is durable.
function idb(mode, op) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const photoKey = (p) => shotsBefore(p.level) + p.shot;

// Resolves to how many photos an earlier page left behind, from shot 1 with no gaps.
export async function openStorage() {
  db = await openDB();
  if (!db) return 0;
  const keys = await idb("readonly", (s) => s.getAllKeys()).catch(() => []);
  const max = Math.min(keys.length, TOTAL_SHOTS);
  let n = 0;
  while (n < max && keys[n] === n) n++;
  return n;
}

export function savePhoto(entry) {
  if (!db) return;
  const meta = { rotation: entry.rotation || null, fov: entry.fov || null, target: entry.target || null };
  idb("readwrite", (s) => s.put({ blob: entry.blob, meta }, photoKey(entry)))
    .then(() => { entry.blob = null; }) // stored: drop the RAM copy
    .catch(() => {});                   // stays in RAM; export reads it from the entry
}

export async function clearStorage() {
  if (db) await idb("readwrite", (s) => s.clear()).catch(() => {});
}

export async function readPhoto(p) {
  if (p.blob) return p.blob;
  if (!db) return null;
  const rec = await idb("readonly", (s) => s.get(photoKey(p)));
  return rec && rec.blob ? rec.blob : rec;
}

export async function readMeta(p) {
  if (!db) return null;
  const rec = await idb("readonly", (s) => s.get(photoKey(p)));
  return rec && rec.meta ? rec.meta : null;
}
