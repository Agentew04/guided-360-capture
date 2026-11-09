// Which phone shot a set. The raw user agent is the source of truth (it can be re-parsed
// later); `model` is a best-effort convenience. Newer Android builds send a reduced UA
// ("Android 10; K"), but Chromium's User-Agent Client Hints expose the real model.

const IPAD_DESKTOP = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

function uaModel(ua) {
  const android = /Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|\s*\))/.exec(ua);
  if (android) return android[1].trim();
  const ios = /\b(iPhone|iPad|iPod)\b/.exec(ua);
  if (ios) return ios[1];
  return IPAD_DESKTOP ? "iPad" : null;
}

export async function describeDevice() {
  const ua = navigator.userAgent || "";
  const info = {
    userAgent: ua,
    platform: navigator.platform || null,
    model: uaModel(ua),
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      pixelRatio: window.devicePixelRatio || 1,
    },
  };

  const uad = navigator.userAgentData;
  if (uad) {
    info.brands = (uad.brands || []).map((b) => `${b.brand} ${b.version}`).join(", ") || null;
    info.mobile = typeof uad.mobile === "boolean" ? uad.mobile : null;
    try {
      const hv = await uad.getHighEntropyValues(["model", "platformVersion", "architecture"]);
      if (hv.model) info.model = hv.model; // e.g. "Pixel 7", better than anything in the UA
      info.platformVersion = hv.platformVersion || null;
      info.architecture = hv.architecture || null;
    } catch (_) {}
  }
  return info;
}
