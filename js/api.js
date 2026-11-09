const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

export const API_URL = LOCAL_HOSTS.includes(location.hostname)
  ? "http://localhost:5000"
  : "https://rpfacco-panorama.northcentralus.cloudapp.azure.com";

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

export function apiUpload(path, body, onProgress) {
  const token = getToken();
  if (!token) return Promise.reject(new AuthError());
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API_URL + path);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        clearToken();
        reject(new AuthError());
      } else {
        resolve(xhr.status);
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(body);
  });
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
