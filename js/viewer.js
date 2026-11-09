import * as THREE from "https://unpkg.com/three@0.132.0/build/three.module.js";
import { DeviceOrientationControls } from "./DeviceOrientationControls.js";

const SENSOR_WAIT_MS = 2000;

const stage = document.getElementById("viewer-stage");
const sensorBtn = document.getElementById("sensor-btn");
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const needsTap = IS_IOS && typeof DeviceOrientationEvent !== "undefined"
  && typeof DeviceOrientationEvent.requestPermission === "function";

export async function startViewer(imageUrl, say) {
  const texture = await new THREE.TextureLoader().loadAsync(imageUrl);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);

  const geometry = new THREE.SphereGeometry(500, 60, 40);
  geometry.scale(-1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const sky = new THREE.Mesh(geometry, material);
  sky.rotation.y = -Math.PI / 2;
  scene.add(sky);

  let controls = null;
  let aligned = false;
  let sensorTimer = null;
  let yaw = 0;
  let pitch = 0;
  let drag = null;
  const events = new AbortController();

  function resize() {
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    camera.aspect = stage.clientWidth / stage.clientHeight;
    camera.updateProjectionMatrix();
  }

  function startSensors() {
    sensorBtn.classList.add("hidden");
    controls = new DeviceOrientationControls(camera);
    sensorTimer = setTimeout(() => {
      if (!aligned) say("Motion sensor not available. Drag to look around.");
    }, SENSOR_WAIT_MS);
  }

  function onPointerDown(e) {
    if (aligned || drag) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    renderer.domElement.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (aligned || drag?.id !== e.pointerId) return;
    const radPerPx = THREE.MathUtils.degToRad(camera.fov) / stage.clientHeight;
    yaw += (e.clientX - drag.x) * radPerPx;
    pitch = THREE.MathUtils.clamp(pitch + (e.clientY - drag.y) * radPerPx, -Math.PI / 2, Math.PI / 2);
    drag.x = e.clientX;
    drag.y = e.clientY;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  }

  function onPointerUp(e) {
    if (drag?.id === e.pointerId) drag = null;
  }

  function frame() {
    if (controls && controls.deviceOrientation.alpha != null) {
      if (!aligned) {
        controls.update();
        controls.alphaOffset = yaw - camera.rotation.y;
        aligned = true;
      }
      controls.update();
    }
    renderer.render(scene, camera);
  }

  window.addEventListener("resize", resize, { signal: events.signal });
  sensorBtn.addEventListener("click", startSensors, { signal: events.signal });
  renderer.domElement.addEventListener("pointerdown", onPointerDown, { signal: events.signal });
  renderer.domElement.addEventListener("pointermove", onPointerMove, { signal: events.signal });
  renderer.domElement.addEventListener("pointerup", onPointerUp, { signal: events.signal });
  renderer.domElement.addEventListener("pointercancel", onPointerUp, { signal: events.signal });

  say("");
  resize();
  renderer.setAnimationLoop(frame);
  if (needsTap) sensorBtn.classList.remove("hidden");
  else startSensors();

  return {
    stop() {
      renderer.setAnimationLoop(null);
      events.abort();
      clearTimeout(sensorTimer);
      controls?.dispose();
      sensorBtn.classList.add("hidden");
      geometry.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
