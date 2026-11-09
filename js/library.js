import { AuthError, api, apiUpload, clearToken, getToken, postJson, setToken } from "./api.js";

const $ = (id) => document.getElementById(id);
const libraryBtn = $("library-btn");
const loginForm = $("login-form"), emailInput = $("email"), passwordInput = $("password");
const registerBtn = $("register-btn"), loginBackBtn = $("login-back-btn"), loginError = $("login-error");
const library = $("library"), libraryBackBtn = $("library-back-btn"), logoutBtn = $("logout-btn");
const zipInput = $("zip-input"), libraryMessage = $("library-message"), list = $("panorama-list");
const viewerBackBtn = $("viewer-back-btn"), viewerMessage = $("viewer-message"), downloadBtn = $("download-btn");

const POLL_MS = 5000;
const STATUS_LABELS = { pending: "Waiting", processing: "Stitching…", done: "Ready", failed: "Failed" };

let panoramas = [];
let pollTimer = null;
let viewer = null;
let viewerGen = 0;
// Not revoked when the viewer closes: Opera reads a download URL only once the user
// confirms its prompt. Same for the list's last download.
let image = null;
let listUrl = null;
let listBusy = false;
let pendingUpload = null;

function show(id) {
  for (const screen of document.querySelectorAll(".screen")) {
    screen.classList.toggle("active", screen.id === id);
    screen.classList.toggle("hidden", screen.id !== id);
  }
  if (id !== "library") clearTimeout(pollTimer);
  if (id !== "viewer") closeViewer();
}

function setMessage(text) {
  libraryMessage.textContent = text;
  libraryMessage.classList.toggle("hidden", !text);
}

function showLoginError(text) {
  loginError.textContent = text;
  loginError.classList.toggle("hidden", !text);
}

function handleError(err) {
  if (err instanceof AuthError) {
    showLoginError("Your session ended. Sign in again.");
    show("login");
  } else {
    setMessage("Could not reach the server.");
  }
}

export function stitchCapture(zip) {
  pendingUpload = zip;
  openLibrary();
}

function openLibrary() {
  if (!getToken()) {
    show("login");
    return;
  }
  setMessage("");
  show("library");
  if (!pendingUpload) {
    refresh();
    return;
  }
  const zip = pendingUpload;
  pendingUpload = null;
  upload(zip);
}

async function signIn() {
  showLoginError("");
  try {
    const res = await postJson("/api/login", { email: emailInput.value, password: passwordInput.value });
    if (res.status === 401) return showLoginError("Wrong email or password.");
    if (!res.ok) return showLoginError(`Sign-in failed (${res.status}).`);
    setToken((await res.json()).token);
  } catch (_) {
    return showLoginError("Could not reach the server.");
  }
  passwordInput.value = "";
  openLibrary();
}

async function register() {
  showLoginError("");
  if (!loginForm.reportValidity()) return;
  try {
    const res = await postJson("/api/register", { email: emailInput.value, password: passwordInput.value });
    if (res.status === 409) return showLoginError("This email already has an account. Sign in instead.");
    if (res.status === 400) return showLoginError("Use a valid email and a password with at least 8 characters.");
    if (!res.ok) return showLoginError(`Could not create the account (${res.status}).`);
  } catch (_) {
    return showLoginError("Could not reach the server.");
  }
  signIn();
}

async function refresh() {
  clearTimeout(pollTimer);
  let res;
  try {
    res = await api("/api/panoramas");
  } catch (err) {
    handleError(err);
    return;
  }
  if (!res.ok) {
    setMessage(`Could not load your panoramas (${res.status}).`);
    return;
  }
  panoramas = await res.json();
  if (!library.classList.contains("active")) return;

  draw();
  if (panoramas.some((p) => p.status === "pending" || p.status === "processing")) {
    pollTimer = setTimeout(refresh, POLL_MS);
  }
}

function draw() {
  if (!panoramas.length) {
    const empty = document.createElement("li");
    empty.className = "pano-empty";
    empty.textContent = "No panoramas yet. Upload the .zip from a capture to stitch one.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...panoramas.map(item));
}

function item(panorama) {
  const title = document.createElement("div");
  title.className = "pano-title";
  title.textContent = `Panorama #${panorama.id}`;

  // SQLite stores UTC; show it in the phone's own time zone.
  const date = document.createElement("div");
  date.className = "pano-date";
  date.textContent = new Date(panorama.created_at.replace(" ", "T") + "Z").toLocaleString();

  const info = document.createElement("div");
  info.className = "pano-info";
  info.append(title, date);

  const badge = document.createElement("span");
  badge.className = `badge ${panorama.status}`;
  badge.textContent = STATUS_LABELS[panorama.status] || panorama.status;

  const row = document.createElement("div");
  row.className = "pano-row";
  row.append(info, badge);

  const li = document.createElement("li");
  li.className = "pano-item";
  li.append(row);

  if (panorama.status === "done") {
    const view = document.createElement("button");
    view.className = "btn small";
    view.textContent = "View";
    view.addEventListener("click", () => openViewer(panorama.id));

    const download = document.createElement("button");
    download.className = "btn small";
    download.textContent = "Download";
    download.addEventListener("click", () => downloadPanorama(panorama.id, download));

    const actions = document.createElement("div");
    actions.className = "pano-actions";
    actions.append(view, download);
    li.append(actions);
  }
  return li;
}

const imageName = (id) => `panorama_${id}.jpg`;

function saveFile(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

// One at a time: the next download revokes this one's URL.
async function downloadPanorama(id, button) {
  if (listBusy) return;
  listBusy = true;
  button.textContent = "Downloading…";
  try {
    const res = await api(`/api/panoramas/${id}/image`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (listUrl) URL.revokeObjectURL(listUrl);
    listUrl = URL.createObjectURL(blob);
    saveFile(listUrl, imageName(id));
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setMessage("Could not download the panorama.");
  } finally {
    listBusy = false;
    button.textContent = "Download";
  }
}

function setViewerMessage(text) {
  viewerMessage.textContent = text;
  viewerMessage.classList.toggle("hidden", !text);
}

async function openViewer(id) {
  const gen = ++viewerGen;
  setViewerMessage("Loading…");
  show("viewer");
  if (image) URL.revokeObjectURL(image.url);
  image = null;
  try {
    const [res, { startViewer }] = await Promise.all([api(`/api/panoramas/${id}/image`), import("./viewer.js")]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (gen !== viewerGen) return;
    image = { url: URL.createObjectURL(blob), name: imageName(id) };
    downloadBtn.classList.remove("hidden");
    const started = await startViewer(image.url, setViewerMessage);
    if (gen !== viewerGen) return started.stop();
    viewer = started;
  } catch (err) {
    if (gen !== viewerGen) return;
    if (err instanceof AuthError) return handleError(err);
    setViewerMessage("Could not open the panorama.");
  }
}

function closeViewer() {
  viewerGen++;
  viewer?.stop();
  viewer = null;
  downloadBtn.classList.add("hidden");
}

zipInput.addEventListener("change", () => {
  const file = zipInput.files[0];
  zipInput.value = "";
  if (file) upload(file);
});

async function keepScreenOn() {
  try {
    return await navigator.wakeLock?.request("screen");
  } catch (_) {
    return null;
  }
}

async function upload(file) {
  const progress = (fraction) => setMessage(`Uploading… ${Math.round(fraction * 100)}%. Keep this screen open.`);
  progress(0);
  const body = new FormData();
  body.append("file", file, file.name || "360_photos.zip");
  const lock = await keepScreenOn();
  try {
    const status = await apiUpload("/api/panoramas", body, progress);
    if (status === 201) setMessage("Uploaded. You can close the app now: stitching takes about 6 minutes.");
    else if (status === 400) setMessage("That file is not a capture .zip.");
    else if (status === 413) setMessage("The file is over 300 MB.");
    else setMessage(`Upload failed (${status}).`);
  } catch (err) {
    handleError(err);
    return;
  } finally {
    lock?.release().catch(() => {});
  }
  refresh();
}

libraryBtn.addEventListener("click", openLibrary);
loginBackBtn.addEventListener("click", () => {
  pendingUpload = null;
  show("intro");
});
libraryBackBtn.addEventListener("click", () => show("intro"));
viewerBackBtn.addEventListener("click", openLibrary);
downloadBtn.addEventListener("click", () => saveFile(image.url, image.name));
registerBtn.addEventListener("click", register);
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  signIn();
});
logoutBtn.addEventListener("click", () => {
  clearToken();
  showLoginError("");
  show("login");
});
