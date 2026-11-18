const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

export const API_URL = LOCAL_HOSTS.includes(location.hostname)
  ? "http://localhost:5000"
  : "https://pano.rodrigoappelt.com.br";

export const GOOGLE_CLIENT_ID = "707159799755-3juiktrdcn90ir50aon2o4pm7itfu229.apps.googleusercontent.com";

const TOKEN_KEY = "guided-360-token";

export class AuthError extends Error {}

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}

export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch (_) {}
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

export function postJson(path, data) {
  return fetch(API_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

const PART_BYTES = 10 * 1024 * 1024;
const PARALLEL_PARTS = 3;
const PART_TRIES = 3;

function putPart(url, token, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(blob);
  });
}

export async function apiUpload(file, onProgress) {
  const token = getToken();
  if (!token) throw new AuthError();
  const path = `/api/uploads/${crypto.randomUUID()}`;
  const count = Math.max(1, Math.ceil(file.size / PART_BYTES));
  const sent = new Array(count).fill(0);
  let next = 0;
  let failed = 0;

  async function sendParts() {
    while (next < count && !failed) {
      const i = next++;
      const blob = file.slice(i * PART_BYTES, (i + 1) * PART_BYTES);
      const progress = (loaded) => {
        sent[i] = loaded;
        onProgress(sent.reduce((a, b) => a + b, 0) / file.size);
      };
      for (let tries = 1; ; tries++) {
        try {
          const status = await putPart(API_URL + `${path}/parts/${i}`, token, blob, progress);
          if (status !== 204) failed = status;
          break;
        } catch (err) {
          if (failed) return;
          if (tries < PART_TRIES) continue;
          failed = -1;
          throw err;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: PARALLEL_PARTS }, sendParts));
  if (failed === 401) {
    clearToken();
    throw new AuthError();
  }
  if (failed) return failed;
  const res = await api(`${path}/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: count }),
  });
  return res.status;
}

export async function api(path, options = {}) {
  const token = getToken();
  if (!token) throw new AuthError();
  const res = await fetch(API_URL + path, {
    ...options,
    headers: { ...options.headers, Authorization: "Bearer " + token },
  });
  if (res.status === 401) {
    clearToken();
    throw new AuthError();
  }
  return res;
}
