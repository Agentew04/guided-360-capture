# Guided 360 Capture

A single-page web app that walks you through shooting a 38-photo turntable set with a
phone: **5 tilt levels** (+90°, +45°, 0°, -45°, -90°) with **1, 10, 16, 10, 1 shots**,
evenly spaced around each level. An on-screen bubble level uses the gyroscope to tell you when the phone
is at the right pitch. Dots pinned to the scene mark where each shot goes: aim the centre
ring at the next one. At the end it packs every shot into a single `.zip`.

All photos come out **3:4 portrait**.

## Deploy

https://rpfacco.github.io/guided-360-capture/

## Running it

The camera and the gyroscope are both gated behind a **secure context**, so the page
has to be served over HTTPS (or `localhost`). Opening `index.html` from the filesystem
will not work, and neither will a plain `http://192.168.x.x` LAN address.

```bash
python -m http.server 8000
```

On the same machine, `http://localhost:8000` is enough, `localhost` counts as secure.
To reach it from a phone you need an HTTPS tunnel, e.g.:

```bash
cloudflared tunnel --url http://localhost:8000
```

## How capture works

Two paths, picked per platform:

| Platform | Preview | Photo |
|---|---|---|
| Android / desktop | light stream, ~1080 short edge | `ImageCapture.takePhoto()`, full sensor |
| iOS | up to 3024×4032 | canvas grab of the preview frame |

On iOS `takePhoto()` reconfigures the capture session on every shot, the preview goes
black and each still allocates a sensor-sized buffer, which kills the tab after a
handful of photos. So iOS draws the preview frame to a canvas instead, which means its
preview has to stay large: there, the photo *is* the preview frame.

Everywhere else the still comes off a separate pipeline, so the preview is free to be
small. If `takePhoto()` throws, or returns something that is not 3:4, the app falls
back to the canvas path for the rest of the run rather than producing a mixed set.

## Export

The `.zip` holds `360_photos/level_NN_shot_NN.jpg` plus a `metadata.json` with, for every
shot: the target tilt/heading, the camera rotation at the shutter (yaw, pitch, roll and
the raw 3x3 device-to-world matrix) and the horizontal/vertical/diagonal FOV.

FOV comes from the still's EXIF `FocalLengthIn35mmFilm` when the device writes it
(the `takePhoto` path, i.e. Android/desktop). iOS grabs the preview on a canvas, which
carries no EXIF, so there the FOV falls back to the assumed ~53 degree horizontal lens
(the same constant the target overlay uses). `metadata.json` records the per-shot source
in `fov.source` and the run-level `fovSource`.

## Memory

Each photo is saved to IndexedDB as it is taken instead of being held in memory until
export. The ZIP is stored, not deflated, because compressing 38 JPEGs in one pass was
enough on its own to push mobile Safari over its limit. If the export dies, lower
`STILL_SETTINGS` in `camera.js`.

## Files

```
index.html         markup
style.css          styling, including the 3:4 preview frame
js/app.js          start-up and capture flow
js/session.js      shot layout, progress, heading reference
js/orientation.js  gyroscope and rotation math
js/camera.js       preview stream and photo capture
js/fov.js          EXIF focal-length read and field-of-view math
js/autoshot.js     automatic shutter
js/hud.js          gauges and on-screen text
js/dome.js         coverage dome
js/targets.js      dots pinned to the scene
js/storage.js      IndexedDB
js/zip.js          ZIP export
```
