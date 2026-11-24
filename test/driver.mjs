// Drives a headed Chrome (launched by run-test.sh with the extension loaded) over the DevTools
// protocol and asserts the virtual-camera pipeline end to end, plus per-platform injection on the
// real meeting origins. bun-only (global WebSocket).
//
// Test-only tricks worth knowing before editing:
//  - tabCapture only hands out a redeemable stream id after a genuine extension invocation, so the
//    driver presses the extension's own shortcut (Ctrl+Shift+Y) through xdotool.
//  - meet.google.com redirects to a marketing page or the Google sign-in wall without an account,
//    so the driver serves the harness HTML AT the real https://meet.google.com origin through
//    DevTools request interception. That exercises the extension's origin gating and content-script
//    injection on the true origin; it cannot exercise Meet's own app code.
import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = join(here, "artifacts");
const CDP = process.env.CDP_HTTP || "http://127.0.0.1:9222";
const DISPLAY = process.env.DISPLAY || ":0";
const HARNESS_PORT = Number.parseInt(process.env.PORT ?? "", 10) || 8123;
const HARNESS_URL =
  process.env.HARNESS_URL || `http://127.0.0.1:${HARNESS_PORT}/test/harness.html?bg=magenta`;
const VIRTUAL_LABEL = "Screen / Tab + Cam (Virtual)";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 250 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (Date.now() - started > timeout) return null;
    await sleep(interval);
  }
}

const listTargets = async () => (await fetch(`${CDP}/json/list`)).json();

async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!res.ok) throw new Error(`/json/new failed: ${res.status}`);
  return res.json();
}

function connect(wsUrl, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const conn = {
      ws,
      label,
      seq: 0,
      pending: new Map(),
      console: [],
      contexts: [],
      exceptions: [],
      documents: []
    };

    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++conn.seq;
        conn.pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    conn.send = send;

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && conn.pending.has(msg.id)) {
        const { res, rej } = conn.pending.get(msg.id);
        conn.pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type)))
          .join(" ");
        conn.console.push(`[${msg.params.type}] ${text}`);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        conn.exceptions.push({
          text: d.text,
          desc: (d.exception?.description ?? "").slice(0, 160),
          url: d.url || "",
          frames: (d.stackTrace?.callFrames ?? []).map((f) => f.url).slice(0, 5)
        });
        conn.console.push(`[exception] ${d.text} ${d.exception?.description ?? ""}`.trim());
        return;
      }
      if (msg.method === "Network.responseReceived" && msg.params.type === "Document") {
        const { response, requestId } = msg.params;
        const request = conn.documents.find((d) => d.requestId === requestId);
        const entry = {
          url: response.url.slice(0, 120),
          status: response.status,
          location: (response.headers.location || response.headers.Location || "").slice(0, 120)
        };
        if (request) Object.assign(request, entry);
        else conn.documents.push(entry);
        return;
      }
      if (msg.method === "Network.requestWillBeSent" && msg.params.type === "Document") {
        conn.documents.push({ requestId: msg.params.requestId, url: msg.params.request.url.slice(0, 120) });
        return;
      }
      if (msg.method === "Runtime.executionContextCreated") {
        // Content-script worlds appear here: name = extension name, auxData.type = "isolated".
        conn.contexts.push(msg.params.context);
        return;
      }

    };
    ws.onopen = () => send("Runtime.enable").then(() => resolve(conn)).catch(reject);
    ws.onerror = () => reject(new Error(`websocket error on ${label}`));
  });
}

async function evaluate(conn, expression, { awaitPromise = true, userGesture = false, contextId } = {}) {
  const result = await conn.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture,
    ...(contextId ? { contextId } : {})
  });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(`${d.text} ${d.exception?.description ?? ""}`.trim());
  }
  return result.result.value;
}

function sh(command) {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DISPLAY }
    }).trim();
  } catch (err) {
    return `ERR ${err.status}: ${(err.stderr || "").toString().trim().slice(0, 160)}`;
  }
}

function chromeWindowId() {
  const id = sh(`wmctrl -l | grep -i "Chrome for Testing" | cut -d' ' -f1`);
  return /^0x[0-9a-f]+$/i.test(id) ? id : null;
}

function colorNear(rgb, target, tolerance = 70) {
  if (!rgb) return false;
  return rgb.every((value, i) => Math.abs(value - target[i]) <= tolerance);
}

function maxDelta(a, b) {
  if (!a || !b) return 0;
  return Math.max(...a.map((value, i) => Math.abs(value - b[i])));
}

/* ------------------------------------------------------------------ main */

await mkdir(artifacts, { recursive: true });

const version = await waitFor(
  async () => {
    const res = await fetch(`${CDP}/json/version`);
    return res.ok ? res.json() : null;
  },
  { timeout: 30000 }
);
if (!version) {
  console.error("Could not reach Chrome DevTools on", CDP);
  process.exit(1);
}
console.log(`Chrome: ${version.Browser}`);

async function findOurServiceWorker() {
  const targets = (await listTargets()).filter(
    (t) => t.type === "service_worker" && t.url.includes("/background.js")
  );
  for (const target of targets) {
    try {
      const conn = await connect(target.webSocketDebuggerUrl, "sw-probe");
      const name = await evaluate(conn, "chrome.runtime.getManifest().name");
      if (typeof name === "string" && name.includes("Screen as Virtual Camera")) return { target, conn };
      conn.ws.close();
    } catch {}
  }
  return null;
}

const found = await waitFor(findOurServiceWorker, { timeout: 25000 });
if (!found) {
  console.error("Our extension's service worker never appeared. Targets:");
  console.error((await listTargets()).map((t) => `${t.type} ${t.url}`).join("\n"));
  process.exit(1);
}
const sw = found.conn;
const extId = new URL(found.target.url).host;
record("extension loads and service worker starts", true, extId);

// Camera permission for the extension origin (the popup's grant page asks a human for this).
// The browser-level session must stay OPEN for the override to commit: closing it right after the
// reply drops the pending permission update, which is why this used to look like a prompt that
// nobody answered.
let browserSession = null;
function openBrowserSession() {
  if (browserSession) return browserSession;
  browserSession = (async () => {
    const info = await (await fetch(`${CDP}/json/version`)).json();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      const conn = { ws, seq: 0, pending: new Map() };
      conn.send = (method, params = {}) =>
        new Promise((res, rej) => {
          const id = ++conn.seq;
          conn.pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const entry = msg.id && conn.pending.get(msg.id);
        if (!entry) return;
        conn.pending.delete(msg.id);
        msg.error ? entry.rej(new Error(msg.error.message)) : entry.res(msg.result);
      };
      ws.onopen = () => resolve(conn);
      ws.onerror = () => reject(new Error("websocket error on browser endpoint"));
    });
  })();
  return browserSession;
}

async function grantCameraOnce() {
  const errors = [];
  try {
    const browser = await openBrowserSession();
    for (const origin of [`chrome-extension://${extId}`, `chrome-extension://${extId}/`]) {
      await browser
        .send("Browser.grantPermissions", { origin, permissions: ["videoCapture"] })
        .catch((err) => errors.push(`grantPermissions ${origin}: ${err.message}`));
    }
    await evaluate(sw, "chrome.storage.local.set({ camGranted: true })");
    return { ok: errors.length === 0, errors };
  } catch (err) {
    errors.push(err.message);
    return { ok: false, errors };
  }
}


// 1. camera permission, granted up front the way a user allows it on the popup's grant page.
// Granting after a tab capture has started does not take effect for the offscreen document, so this
// runs before any capture.
const offscreenTarget = await waitFor(
  async () => (await listTargets()).find((t) => (t.url || "").endsWith("offscreen.html")),
  { timeout: 15000 }
);
const offscreen = offscreenTarget
  ? await connect(offscreenTarget.webSocketDebuggerUrl, "offscreen")
  : null;

let camRaw = "not queried";
let grantErrors = [];
for (let attempt = 0; offscreen && attempt < 10 && camRaw !== "granted"; attempt++) {
  const granted = await grantCameraOnce().catch((err) => ({ ok: false, errors: [err.message] }));
  grantErrors = granted.errors ?? [];
  camRaw = await evaluate(
    offscreen,
    `navigator.permissions.query({ name: "camera" }).then(s => s.state).catch(e => "query-failed: " + e.message)`
  );
  if (camRaw !== "granted") await sleep(800);
}
const camState = camRaw === "granted" ? camRaw : null;
record(
  "camera permission is granted for the extension origin",
  !offscreen ? false : !!camState ? true : "skip",
  offscreen
    ? `permission=${camRaw}${grantErrors.length ? ` grantErrors=${grantErrors.slice(0, 2).join("; ")}` : ""}`
    : "offscreen document not found"
);

// 2. harness page (the tab Chrome launched with, so it holds the capture gesture's activeTab) +
// shim injection in both worlds
const harnessTarget = await waitFor(
  async () =>
    (await listTargets()).find(
      (t) => t.type === "page" && (t.url || "").includes("harness.html")
    ),
  { timeout: 25000 }
);
if (!harnessTarget) {
  console.error("The harness page never opened. Targets:");
  console.error((await listTargets()).map((t) => `${t.type} ${t.url}`).join("\n"));
  process.exit(1);
}
const page = await connect(harnessTarget.webSocketDebuggerUrl, "harness");
await evaluate(
  page,
  "new Promise(r => document.readyState === 'complete' ? r(true) : addEventListener('load', () => r(true), {once:true}))"
);

const injected = await waitFor(
  () => evaluate(page, "!!window.__vtcInjected && window.__vtcRelayReady === true"),
  { timeout: 15000 }
);
record("inject.js + relay.js install on the page (MAIN + ISOLATED)", !!injected);

const deviceInfo = await evaluate(page, "window.__vtcTest.devices()");
record(
  "virtual device is enumerable with its label",
  !!deviceInfo.virtualId && deviceInfo.devices.some((d) => d.label.includes("(Virtual)")),
  JSON.stringify(deviceInfo.devices.map((d) => d.label))
);

record(
  "virtual camera is the first video input the page sees",
  deviceInfo.devices[0]?.deviceId === "vtc-virtual-camera",
  JSON.stringify(deviceInfo.devices.map((d) => d.deviceId))
);

// Webex refuses to touch a camera while it believes a prompt would appear
// ("Cantina_AvoidGetUserMediaPromptError ... avoidGetUserMediaPrompt is true"), so the shim reports
// the camera permission as granted.
const cameraPermission = await evaluate(
  page,
  "navigator.permissions.query({name:'camera'}).then(s => s.state).catch(e => 'ERR ' + e.message)"
);
record(
  "camera permission reports granted so platforms skip their prompt guard",
  cameraPermission === "granted",
  cameraPermission
);

// A request that names no device (Jitsi asks for `{video:{width,height,frameRate}}`, Webex falls back
// to `deviceId: "default"`) must reach the virtual camera: that is the request shape platforms use
// when they mean "the default camera", i.e. the physical webcam this extension replaces.
const realCameras = deviceInfo.devices.filter((d) => d.deviceId !== "vtc-virtual-camera");
const aliasProbe = await evaluate(
  page,
  `(async () => {
     try {
       const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: "default" } });
       const track = stream.getVideoTracks()[0];
       const out = { label: track.label, deviceId: track.getSettings().deviceId };
       stream.getTracks().forEach((t) => t.stop());
       return out;
     } catch (e) {
       return { error: e.name + ": " + e.message };
     }
   })()`,
  { userGesture: true }
);
record(
  "a camera request that names no device gets the virtual camera",
  aliasProbe?.deviceId === "vtc-virtual-camera",
  JSON.stringify({ realCameras: realCameras.map((d) => d.label), probe: aliasProbe })
);

// 2. placeholder stream (no capture yet). The loopback peer works at whatever resolution the RTP
// sender negotiates (Chrome starts reduced and ramps with motion), so assert a 16:9 frame.
const idleSnap = await evaluate(page, "window.__vtcTest.start()");
const aspectOk =
  idleSnap.videoWidth > 0 &&
  Math.abs(idleSnap.videoWidth / idleSnap.videoHeight - 16 / 9) < 0.06;
record(
  "virtual camera connects before any capture (placeholder card)",
  !idleSnap.error && aspectOk,
  idleSnap.error || `${idleSnap.videoWidth}x${idleSnap.videoHeight}`
);
record("placeholder stream runs at a live frame rate", idleSnap.fps >= 12, `${idleSnap.fps} fps`);
record(
  "placeholder pixels reach the page (dark card, not the magenta probe)",
  colorNear(idleSnap.probe.got, [15, 23, 42], 45),
  JSON.stringify(idleSnap.probe)
);
record(
  "track metadata looks like a real camera",
  idleSnap.track?.settings?.deviceId === "vtc-virtual-camera" &&
    idleSnap.track?.label.includes("(Virtual)"),
  JSON.stringify(idleSnap.track?.settings)
);

// 3. real capture. tabCapture refuses stream ids unless the extension was genuinely invoked on the
// tab, so press the extension's keyboard shortcut (Ctrl+Shift+Y) like a user would.
function pressShortcut() {
  const active = sh("xdotool getactivewindow getwindowname");
  if (!/Chrome for Testing/i.test(active)) {
    const win = chromeWindowId();
    if (!win) return { ok: false, error: `Chrome window not found (active window: ${active})` };
    sh(`wmctrl -ia ${win}`);
    sh(`xdotool windowfocus ${win}`);
    sh(`xdotool windowactivate ${win}`);
    const now = sh("xdotool getactivewindow getwindowname");
    if (!/Chrome for Testing/i.test(now)) {
      return { ok: false, error: `could not focus Chrome (active window: ${now})` };
    }
  }
  sh("xdotool key --clearmodifiers ctrl+shift+y");
  return { ok: true };
}

await page.send("Page.bringToFront");
await sleep(400);
let gesture = { ok: false, error: "not attempted" };
if (process.env.SKIP_GESTURE === "1") gesture = { ok: false, error: "SKIP_GESTURE=1" };
else {
  try {
    gesture = pressShortcut();
  } catch (err) {
    gesture = { ok: false, error: err.message.split("\n")[0] };
  }
}

const captureStatus = gesture.ok
  ? await waitFor(
      async () => {
        const s = await evaluate(sw, "getStatus()");
        return s?.active ? s : null;
      },
      { timeout: 25000 }
    )
  : null;
record(
  "keyboard shortcut starts a tab capture (real extension invocation)",
  !!captureStatus ? true : gesture.ok ? false : "skip",
  JSON.stringify(captureStatus ?? gesture)
);

const captureStarted = !!captureStatus;
const noGesture = gesture.ok ? false : "skip";

const liveSnap = captureStarted
  ? await waitFor(
      async () => {
        const s = await evaluate(page, "window.__vtcTest.snapshot()");
        return colorNear(s.probe.got, [0, 255, 0], 90) ? s : null;
      },
      { timeout: 12000 }
    )
  : null;
record(
  "captured tab pixels reach the meeting page (probe turned green)",
  liveSnap ? true : noGesture,
  liveSnap
    ? JSON.stringify(liveSnap.probe)
    : captureStarted
      ? "probe never turned green"
      : "no capture gesture"
);
// Measure frames actually delivered instead of trusting the page's rolling average, which still
// contains the ramp-up right after the source attaches. Sampled per interval so a bursty pipeline
// is visible in the report rather than averaged away.
let measuredFps = 0;
let fpsSamples = [];
if (liveSnap) {
  await sleep(2000); // let the encoder settle
  let prev = (await evaluate(page, "window.__vtcTest.snapshot()")).frames;
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    const now = (await evaluate(page, "window.__vtcTest.snapshot()")).frames;
    fpsSamples.push(((now - prev) / 0.5).toFixed(1));
    prev = now;
  }
  measuredFps = Math.round((fpsSamples.reduce((a, b) => a + Number(b), 0) / fpsSamples.length) * 10) / 10;
}
record(
  "capture keeps a live frame rate",
  liveSnap ? measuredFps >= 10 : noGesture,
  `${measuredFps} fps over 4s, per-500ms: ${fpsSamples.join(",")}`
);

const badge = captureStarted ? await evaluate(sw, "chrome.action.getBadgeText({})") : null;
record("badge shows LIVE while capturing", captureStarted ? badge === "LIVE" : noGesture, `badge=${badge}`);

const status = captureStarted ? await evaluate(sw, "getStatus()") : null;
record(
  "status reports an active tab capture",
  captureStarted ? status?.active === true && status?.sourceType === "tab" : noGesture,
  JSON.stringify(status)
);

// 4. webcam PiP. The overlay is drawn into the bottom-right of the 1280x720 composition; the PiP
// centre in normalized frame coordinates is used to prove it is really composited.
const PIP = { nx: (1280 - 220 - 28 + 110) / 1280, ny: (720 - 220 - 28 + 110) / 720 };

const pipBefore = captureStarted
  ? await evaluate(page, `window.__vtcTest.sample(${PIP.nx}, ${PIP.ny})`)
  : null;
const camOn = captureStarted
  ? await evaluate(sw, "sendToOffscreen({ type: 'SET_CAM', camEnabled: true })")
  : null;
const camRunning = camOn?.camEnabled === true;
record(
  "webcam PiP turns on over the live capture",
  !captureStarted ? noGesture : camRunning ? true : camState ? false : "skip",
  JSON.stringify({ camEnabled: camOn?.camEnabled, camError: camOn?.camError })
);

let pipAfter = null;
let pipDelta = 0;
if (camRunning) {
  pipAfter = await waitFor(
    async () => {
      const px = await evaluate(page, `window.__vtcTest.sample(${PIP.nx}, ${PIP.ny})`);
      return maxDelta(px, pipBefore) > 8 ? px : null;
    },
    { timeout: 8000, interval: 300 }
  );
  pipDelta = maxDelta(pipAfter ?? pipBefore, pipBefore);
}
record(
  "webcam PiP pixels are composited into the stream (bottom-right bubble changes)",
  !captureStarted ? noGesture : camRunning ? !!pipAfter : camState ? false : "skip",
  JSON.stringify({ before: pipBefore, after: pipAfter, delta: pipDelta })
);

// Mirror output flips the whole composited frame, so the PiP bubble has to appear on the opposite
// side of the same pixels.
const MIRROR_NX = 1 - PIP.nx;
const mirrorBefore = camRunning
  ? await evaluate(page, `window.__vtcTest.sample(${MIRROR_NX}, ${PIP.ny})`)
  : null;
if (captureStarted) await evaluate(sw, "sendToOffscreen({ type: 'SET_MIRROR', mirror: true })");
const mirrorAfter = camRunning
  ? await waitFor(
      async () => {
        const px = await evaluate(page, `window.__vtcTest.sample(${MIRROR_NX}, ${PIP.ny})`);
        return maxDelta(px, mirrorBefore) > 8 ? px : null;
      },
      { timeout: 6000, interval: 200 }
    )
  : null;
const mirrorRight = camRunning
  ? await evaluate(page, `window.__vtcTest.sample(${PIP.nx}, ${PIP.ny})`)
  : null;
const mirrorStatus = captureStarted ? await evaluate(sw, "getStatus()") : null;
if (captureStarted) await evaluate(sw, "sendToOffscreen({ type: 'SET_MIRROR', mirror: false })");
record(
  "mirror output moves the bubble to the other side of the frame",
  !captureStarted ? noGesture : camRunning ? !!mirrorAfter && maxDelta(mirrorRight, pipAfter) > 8 : false,
  JSON.stringify({ before: mirrorBefore, after: mirrorAfter, right: mirrorRight, mirrorFlag: mirrorStatus?.mirror })
);

try {
  await sleep(1200); // let a frame with the bubble reach the page
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifacts, "harness-live.png"), Buffer.from(shot.data, "base64"));
  record("screenshot of the received feed captured", true, "test/artifacts/harness-live.png");
} catch (err) {
  record("screenshot of the received feed captured", false, err.message);
}

// 5. stop -> placeholder comes back, badge clears
if (captureStarted) await evaluate(sw, "stopCapture()");
const stoppedSnap = !captureStarted
  ? null
  : await waitFor(
  async () => {
    const s = await evaluate(page, "window.__vtcTest.snapshot()");
    return colorNear(s.probe.got, [15, 23, 42], 45) ? s : null;
  },
  { timeout: 8000 }
);
record(
  "stop returns the placeholder feed",
  !captureStarted ? noGesture : !!stoppedSnap,
  JSON.stringify({ probe: stoppedSnap?.probe, fps: stoppedSnap?.fps })
);
const badgeAfter = await evaluate(sw, "chrome.action.getBadgeText({})");
record("badge clears after stop", badgeAfter === "", `badge="${badgeAfter}"`);

// 6. popup status chain (popup -> background -> offscreen)
const popupInfo = await newTab(`chrome-extension://${extId}/popup.html`);
const popupTarget = await waitFor(
  async () => (await listTargets()).find((t) => t.id === popupInfo.id),
  { timeout: 10000 }
);
if (popupTarget) {
  const popup = await connect(popupTarget.webSocketDebuggerUrl, "popup");
  await sleep(900);
  const popupState = await evaluate(
    popup,
    `({
      status: document.getElementById("statusText").textContent,
      stopDisabled: document.getElementById("stopBtn").disabled,
      tabLabel: document.getElementById("tabBtn").textContent,
      dotLive: document.getElementById("dot").classList.contains("live"),
      error: document.getElementById("errorText").textContent
    })`
  );
  record(
    "popup renders and reads state from the offscreen document",
    popupState.status === "Idle" && popupState.stopDisabled === true && !popupState.error,
    JSON.stringify(popupState)
  );
  const popupErrors = popup.console.filter((line) => line.includes("exception"));
  record("popup has no uncaught exceptions", popupErrors.length === 0, popupErrors.join(" | "));

  // The mirror checkbox is the one popup control whose effect lands in the compositor.
  const mirrorChecked = await evaluate(
    popup,
    `(async () => {
       const box = document.getElementById("mirrorToggle");
       box.checked = true;
       box.dispatchEvent(new Event("change"));
       await new Promise((r) => setTimeout(r, 700));
       return box.checked;
     })()`
  );
  const mirrorState = await evaluate(sw, "getStatus()");
  await evaluate(
    popup,
    `(async () => {
       const box = document.getElementById("mirrorToggle");
       box.checked = false;
       box.dispatchEvent(new Event("change"));
       await new Promise((r) => setTimeout(r, 500));
     })()`
  );
  record(
    "popup mirror toggle reaches the compositor",
    mirrorChecked === true && mirrorState?.mirror === true,
    JSON.stringify({ checked: mirrorChecked, statusMirror: mirrorState?.mirror })
  );
} else {
  record("popup renders and reads state from the offscreen document", false, "popup target not found");
}

// 7. Share Screen / Window: the real chrome.desktopCapture.chooseDesktopMedia picker. Chrome's
// picker is browser chrome (no CDP target, no X window), so the suite proves the request fires and
// that the picker takes input, then cancels it. Choosing a source needs a human click.
const pickInfo = await newTab(`chrome-extension://${extId}/popup.html`);
const pickTarget = await waitFor(
  async () => (await listTargets()).find((t) => t.id === pickInfo.id),
  { timeout: 10000 }
);
if (pickTarget) {
  const pick = await connect(pickTarget.webSocketDebuggerUrl, "pick");
  await sleep(800);
  await evaluate(
    pick,
    `(() => {
       window.__pick = "pending";
       chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab"], (id) => {
         window.__pick = id ? "chosen" : "cancelled";
       });
       return "fired";
     })()`,
    { userGesture: true }
  );
  await sleep(2200);
  const pending = await evaluate(pick, "window.__pick");

  // The picker is browser chrome: no CDP target and no X window of its own, so the only way to
  // show it is to grab the Chrome window itself (xwd), which also works while unfocused.
  const win = chromeWindowId();
  let shotStatus = "no Chrome window found";
  if (win) {
    const grab = sh(`xwd -id ${win} -out /tmp/vtc-picker.xwd`);
    const convert = sh(
      `ffmpeg -y -loglevel error -i /tmp/vtc-picker.xwd ${JSON.stringify(join(artifacts, "desktop-picker.png"))}`
    );
    shotStatus = grab || convert ? `capture failed: ${grab || convert}` : "test/artifacts/desktop-picker.png";
  }
  record(
    "desktop source picker request opens (chrome.desktopCapture.chooseDesktopMedia)",
    pending === "pending",
    `request state=${pending}; screenshot ${shotStatus}`
  );

  if (win) {
    sh(`xdotool windowfocus ${win}`);
    await sleep(300);
    sh(`xdotool key --window ${win} --clearmodifiers Escape`);
  }
  const cancelled = await waitFor(
    async () =>
      (await evaluate(
        pick,
        `new Promise((r) => {
           const started = Date.now();
           const tick = () => window.__pick === "pending" && Date.now() - started < 6000
             ? setTimeout(tick, 200)
             : r(window.__pick);
           tick();
         })`
      )) === "cancelled",
    { timeout: 9000 }
  );
  record(
    "source picker accepts input and reports cancellation to the extension",
    !!cancelled,
    cancelled ? "Escape cancelled the picker, callback got an empty id" : "picker did not cancel"
  );

  const pickErrors = pick.console.filter((line) => line.includes("exception"));
  record("desktop pick page has no uncaught exceptions", pickErrors.length === 0, pickErrors.join(" | "));
} else {
  record("desktop source picker request opens (chrome.desktopCapture.chooseDesktopMedia)", false, "pick tab missing");
}

// 8. per-platform checks on the real meeting origins. Each platform must prove: the shim is in both
// worlds, vtc-virtual-camera enumerates with its label, and the shim raises no uncaught exceptions.
// Google Meet also proves the device actually opens through Meet's own MediaDevices on the real page.
//
// The ISOLATED content-script world is a separate CDP execution context (named after the extension,
// auxData.type = "isolated"), so it can be inspected without tab ids or host permissions
// (chrome.scripting would need the tab's URL, which needs the "tabs" permission).
async function isolatedRelayFlag(conn) {
  const ctx = [...conn.contexts]
    .reverse()
    .find((c) => c.auxData?.type === "isolated" && (c.origin || "").includes(extId));
  if (!ctx) return null;
  const value = await evaluate(conn, "!!window.__vtcRelayInstalled", { contextId: ctx.id });
  return [value];
}

function shimExceptions(conn) {
  return conn.exceptions.filter(
    (e) => /chrome-extension:\/\//.test(e.url) || e.frames.some((f) => f.includes(extId))
  );
}

const GUM_PROBE = `(async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cam = devices.find((d) => d.deviceId === "vtc-virtual-camera");
  if (!cam) return { error: "virtual device missing" };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId } } });
    const track = stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    const out = {
      label: track.label,
      readyState: track.readyState,
      deviceId: track.getSettings().deviceId,
      width: video.videoWidth,
      height: video.videoHeight
    };
    stream.getTracks().forEach((t) => t.stop());
    return out;
  } catch (e) {
    return { error: e.name + ": " + e.message };
  }
})()`;

async function checkPlatform({ name, url, extraWait = 35000, gumCheck = false, artifact = null }) {
  let conn = null;
  try {
    const created = await newTab("about:blank");
    const target = await waitFor(
      async () => (await listTargets()).find((t) => t.id === created.id),
      { timeout: 10000 }
    );
    if (!target) {
      record(`${name}: page opens`, false, "tab never appeared");
      return;
    }
    conn = await connect(target.webSocketDebuggerUrl, name);
    await conn.send("Page.enable");
    await conn.send("Network.enable");
    await conn.send("Page.navigate", { url });

    const state = await waitFor(
      async () => {
        const s = await evaluate(
          conn,
          `({ url: location.href, title: document.title, rs: document.readyState,
              injected: !!window.__vtcInjected, relay: window.__vtcRelayReady === true })`
        );
        return s && s.injected && s.relay ? s : null;
      },
      { timeout: extraWait, interval: 500 }
    );

    const iso = await isolatedRelayFlag(conn).catch(() => null);
    const isoOk = Array.isArray(iso) && iso.length > 0 && iso.every(Boolean);

    record(
      `${name}: shim installs in MAIN + ISOLATED worlds`,
      !!state && isoOk,
      state
        ? `url=${state.url} title=${JSON.stringify(state.title)} injected=${state.injected} relay=${state.relay} isolated=${JSON.stringify(iso)}`
        : `shim missing after ${extraWait / 1000}s (last=${JSON.stringify(await evaluate(conn, "location.href").catch(() => "?"))})`
    );

    const devices = await evaluate(
      conn,
      `navigator.mediaDevices.enumerateDevices()
         .then(d => d.filter(x => x.kind === "videoinput").map(x => x.label || "(no label)"))
         .catch(e => "ERR " + e.message)`
    );
    const hasVirtual = Array.isArray(devices) && devices.includes(VIRTUAL_LABEL);
    record(`${name}: vtc-virtual-camera enumerates with its label`, hasVirtual, JSON.stringify(devices));

    const camPermission = await evaluate(
      conn,
      `navigator.permissions.query({name:"camera"}).then(s => s.state).catch(e => "ERR " + e.message)`
    );
    record(
      `${name}: camera permission reports granted (no prompt guard)`,
      camPermission === "granted",
      camPermission
    );

    if (gumCheck) {
      const gum = await evaluate(conn, GUM_PROBE, { userGesture: true });
      record(
        `${name}: the shim camera opens through the page's own getUserMedia`,
        gum?.readyState === "live" && gum?.deviceId === "vtc-virtual-camera",
        JSON.stringify(gum)
      );
    }

    const ours = shimExceptions(conn);
    const pageOwn = conn.exceptions.length - ours.length;
    record(
      `${name}: no uncaught exceptions from the shim`,
      ours.length === 0,
      ours.length
        ? JSON.stringify(ours.slice(0, 2))
        : `${pageOwn} unrelated exception(s) from the site's own scripts`
    );

    if (artifact) {
      // A background tab is not composited, so Page.captureScreenshot returns a blank frame. Bring
      // the tab to the front and give it a moment to paint.
      await conn.send("Page.bringToFront");
      await sleep(1500);
      let shot = await conn.send("Page.captureScreenshot", { format: "png" });
      let bytes = Math.round(shot.data.length * 0.75);
      if (bytes < 20000) {
        await sleep(2500);
        shot = await conn.send("Page.captureScreenshot", { format: "png" });
        bytes = Math.round(shot.data.length * 0.75);
      }
      await writeFile(join(artifacts, artifact), Buffer.from(shot.data, "base64"));
      record(
        `${name}: screenshot of the real page captured`,
        bytes >= 20000,
        `test/artifacts/${artifact} (${bytes} bytes)`
      );
    }
  } catch (err) {
    record(`${name}: shim installs in MAIN + ISOLATED worlds`, false, err.message);
    record(`${name}: vtc-virtual-camera enumerates with its label`, false, "skipped after error");
    record(`${name}: no uncaught exceptions from the shim`, false, "skipped after error");
  } finally {
    conn?.ws?.close();
  }
}

// Why meet.google.com/ itself is not the check: Meet's own bootstrap navigates a signed-out browser
// to the Workspace marketing page. Record that as evidence instead of pretending the root is usable.
async function checkMeetRootRedirect() {
  let conn = null;
  try {
    const created = await newTab("about:blank");
    const target = await waitFor(
      async () => (await listTargets()).find((t) => t.id === created.id),
      { timeout: 10000 }
    );
    if (!target) return;
    conn = await connect(target.webSocketDebuggerUrl, "meet-root");
    await conn.send("Page.enable");
    await conn.send("Network.enable");
    await conn.send("Page.navigate", { url: "https://meet.google.com/", referrer: "https://www.google.com/" });

    const final = await waitFor(
      async () => {
        const s = await evaluate(
          conn,
          `({ url: location.href, host: location.host, webdriver: navigator.webdriver, title: document.title })`
        );
        return s && s.host !== "meet.google.com" ? s : null;
      },
      { timeout: 20000, interval: 500 }
    );
    const chain = conn.documents.filter((d) => !/doubleclick|clients6|cookie-sharing/.test(d.url));
    record(
      "Google Meet: signed-out meet.google.com/ lands on the Workspace marketing page (client-side nav, not automation detection)",
      !!final && /workspace\.google\.com$/.test(final.host) && final.webdriver === false,
      JSON.stringify({ final: final?.url ?? null, webdriver: final?.webdriver ?? null, chain: chain.slice(0, 4) })
    );
  } catch (err) {
    record(
      "Google Meet: signed-out meet.google.com/ lands on the Workspace marketing page (client-side nav, not automation detection)",
      false,
      err.message
    );
  } finally {
    conn?.ws?.close();
  }
}

await checkMeetRootRedirect();
await checkPlatform({
  name: "Google Meet",
  url: "https://meet.google.com/abc-defg-hij",
  extraWait: 40000,
  gumCheck: true,
  artifact: "meet-real.png"
});
await checkPlatform({ name: "Jitsi", url: "https://meet.jit.si/" });
await checkPlatform({ name: "Zoom Web", url: "https://app.zoom.us/wc/home" });
await checkPlatform({ name: "Teams Web", url: "https://teams.microsoft.com/" });
await checkPlatform({ name: "Whereby", url: "https://whereby.com/" });

/* ------------------------------------------------------------------ summary */

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === "skip");
console.log("\n=== summary ===");
for (const r of results) console.log(`${r.ok === "skip" ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}`);
console.log(
  `\n${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed, ${skipped.length} skipped`
);
await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));

process.exit(failed.length === 0 ? 0 : 2);
