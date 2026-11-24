# AGENTS.md — Screen as Virtual Camera (Chrome MV3 extension)

Project instructions for any agent (or human) working in this repo. Read this before changing code.

## What this project is

A Chrome Manifest V3 extension that turns a **captured tab, window, or screen** into a **virtual camera**
that any *web* meeting platform can select as a normal camera device (Google Meet, Zoom Web, Microsoft Teams
Web, Jitsi, Webex, Whereby, Discord, Slack huddles, etc.). No native drivers, no OS virtual device, no bridge
process. Everything stays inside Chrome.

Value proposition: share a demo/tab as your *camera* feed instead of taking over the meeting's screen-share
slot (useful when you are not host and cannot share, on managed laptops, Chromebooks, etc.).

## Architecture (3-part pipeline, do not redesign casually)

```
meeting page (MAIN world)      inject.js   patches MediaDevices: adds virtual device + intercepts getUserMedia
        |  window.postMessage (source: "vtc-inject")
meeting page (ISOLATED world)  relay.js    bridges page <-> extension messaging (all_frames: true)
        |  chrome.runtime.sendMessage (target: "background")
service worker                 background.js  orchestrates offscreen doc, relays signaling, badge
        |  chrome.runtime.sendMessage (target: "offscreen")
offscreen document             offscreen.js  tabCapture/desktopCapture + webcam -> <canvas> compositor
        |  loopback RTCPeerConnection (vanilla ICE, iceServers: [])
meeting page (MAIN world)      inject.js   hands the received video track back as a MediaStream
```

Key invariants:

1. **`inject.js` runs in the MAIN world** at `document_start`, `all_frames: true`. It must never assume it is
   first to run twice: it is guarded by `window.__vtcInjected`.
2. **Content scripts cannot be reached from the offscreen document.** All offscreen→page traffic goes through
   the service worker (`RELAY_TO_TAB`, addressed by `tabId` + `frameId`). Keep that routing in `background.js`.
3. **The offscreen document is the single source of truth** for capture state (`GET_STATUS`). The popup never
   keeps its own copy of "is it live".
4. **The virtual device must stay selectable even before capture starts.** The composited canvas always exists
   and renders a placeholder card, so `getUserMedia` on the virtual device resolves immediately instead of
   hanging the meeting UI. The 30 fps draw loop keeps running when no source is attached, so stopping a capture
   shows the card again instead of freezing the last captured frame in the meeting.
4b. **Frames come from WebCodecs, not `captureStream()`.** An offscreen document is a hidden page: a captured
   canvas there emits about one frame. `offscreen.js` therefore writes `VideoFrame(canvas)` into a
   `MediaStreamTrackGenerator` at 30 fps (`canvas.captureStream` remains only as a fallback).
5. **Webcam permission belongs to the extension origin.** Offscreen documents cannot prompt, so the user grants
   camera access on a real extension page (`popup.html?mode=grant`). Keep the grant flow.
6. **Never leave the webcam LED on.** Every `stop` path stops the webcam tracks too.
7. Messages use an explicit `target` (`"background"` / `"offscreen"`) or `source` (`"vtc-relay"`) tag. A listener
   that is not addressed must `return false` so it does not steal `sendResponse`.

## File layout

```
extension/            loadable unpacked extension (this folder has manifest.json)
  manifest.json
  background.js       service worker
  offscreen.html/.js  compositor + loopback WebRTC answerer
  popup.html/.js      controls (share tab / share screen / webcam toggle / stop / enable on this page)
  inject.js           MAIN world shim
  relay.js            ISOLATED world bridge
test/                 dev-only harness (never shipped)
  build.mjs           writes dist/dev (adds localhost content-script match + host permission for testing)
  serve.mjs           static server for the harness page
  driver.mjs          bun + CDP driver for a headed Chrome
  run-test.sh         one-shot: build, serve, launch headed Chrome, run driver
  harness.html        stand-in "meeting platform" page used by the driver
dist/                 generated, git-ignored
```

## Conventions

- Vanilla JS only. No build step for the shipped extension, no dependencies, no TypeScript, no bundler.
- No frameworks, no npm packages in `extension/`. It must load with "Load unpacked" as-is.
- Console logs are prefixed `[VTC:<component>]` (`bg`, `popup`, `offscreen`, `inject`, `relay`). Keep this so
  tests and users can grep them; it is the project's debug interface.
- Keep the extension's permissions minimal: `activeTab`, `tabCapture`, `desktopCapture`, `offscreen`,
  `scripting`, `storage`. Do not add `<all_urls>` host permissions to the shipped manifest — broad coverage is
  done with `content_scripts.matches` plus the popup's one-shot "Enable on this page" (needs `activeTab` only).
- Do not rename `VIRTUAL_ID` (`vtc-virtual-camera`) without updating `test/harness.html`.
- UI copy stays plain and short; no emoji in extension UI.

## How to verify a change

```
bash test/run-test.sh
```

It builds `dist/dev`, serves the harness on `127.0.0.1:8123`, launches a **headed** Chrome for Testing with the
extension loaded (no fake media flags, see below) and runs `test/driver.mjs` over CDP. The driver asserts: the
virtual device is enumerable, the placeholder stream connects (16:9, ~20-30 fps), a real tab capture started by
the extension's Ctrl+Shift+Y command actually reaches the page (pixel probe), the camera overlay toggles, stop
returns the placeholder, the badge clears, and the popup's status chain works. Results and a screenshot land in
`test/artifacts/` (`results.json`, `harness-live.png`).

Capture needs a genuine extension invocation, which automation cannot produce by clicking the toolbar icon, so
the driver focuses the Chrome window with `wmctrl` and presses Ctrl+Shift+Y with `xdotool`. That is why the
harness launches with `--ozone-platform=x11` and why a session without a focused X11 window reports those checks
as skipped rather than failed.

It then checks the meeting origins themselves — **Google Meet, Jitsi, Zoom Web, Teams Web, Whereby** — and for each
one records three results: the shim is present in the MAIN world *and* the ISOLATED content-script world, the
virtual device enumerates as `Screen / Tab + Cam (Virtual)`, and no shim exceptions were raised. Details that
matter when editing that part of the driver:

- The ISOLATED world is inspected as a CDP execution context (`Runtime.executionContextCreated`, name = extension
  name, `auxData.type === "isolated"`). `chrome.scripting.executeScript` cannot be used: without the `tabs`
  permission the worker cannot read `tab.url` and scripting refuses the tab.
- **Meet is checked on its real app page**, `https://meet.google.com/<code>`, with no request interception. That
  URL returns 200 and Meet's own bundle renders its "Check your meeting code" screen (and, intermittently, its
  "Do you want people to see and hear you in the meeting?" prompt). `meet.google.com/` and `/landing` are *not*
  usable for this: the root answers **HTTP 200 with no Location header** and Meet's own bootstrap then navigates a
  signed-out browser to `workspace.google.com/products/meet/`, while `/landing` and `/new` go to
  `accounts.google.com` sign-in. That is a client-side product decision, not automation detection — the suite
  launched with `--disable-blink-features=AutomationControlled`, a normal desktop UA and reports
  `navigator.webdriver === false`.
- The Meet check also opens the shim's camera through the page's own `getUserMedia` and asserts a live track with
  `deviceId: "vtc-virtual-camera"`, which is the closest automatable proxy for Meet's device picker (the real
  picker needs a valid meeting, i.e. an account).
- Meet throws its own `_.mF` / `_.pRh` promise rejections from `/scs/mss-static/...MeetingsDesktopUi...`; they
  reproduce in a Chrome **without** the extension. The driver therefore classifies exceptions: only those whose
  URL or stack points at `chrome-extension://` fail the "no uncaught exceptions from the shim" check.
- The webcam overlay uses a permission granted through the browser-level CDP session, which **must stay open** for
  the override to commit; the driver then polls `navigator.permissions.query({name:"camera"})` in the offscreen
  document and asserts the bubble by sampling the PiP centre of the received frame.
- The desktop picker is Chrome browser chrome: no CDP target, no X window, so the driver fires the real
  `chooseDesktopMedia`, screenshots the Chrome window with `xwd` + `ffmpeg`, and cancels with `Escape` to prove the
  request was pending. Choosing a source needs a human.

If you cannot run a headed browser (no `DISPLAY`), say so explicitly in your report instead of claiming a pass.

## Known constraints / gotchas we already accounted for

- **Never launch Chrome with `--use-fake-ui-for-media-stream` or `--use-fake-device-for-media-stream`.** Under
  Chrome's fake media UI, `getUserMedia({video:{mandatory:{chromeMediaSource:"tab",...}}})` fails with
  `NotFoundError: Requested device not found` **even in the page that created the id**, which looks exactly like
  a permissions bug. This one flag invalidated a whole day of debugging; it is in the harness comments too.
- `tabCapture.getMediaStreamId({targetTabId})` needs a real extension invocation for that tab (`activeTab` from a
  popup click, the Ctrl+Shift+Y command, or an activeTab grant); host permissions alone do not satisfy it.
  Ids created by the popup or the service worker *are* redeemable in the offscreen document on Chrome 158
  (verified: 1922x1080 real tab frames).
- A **failed** redemption leaves the tab locked (`Cannot capture a tab with an active stream`) until that tab is
  reloaded or closed. Reload the page before retrying, or the next attempt fails for the wrong reason.
- `desktopCapture.chooseDesktopMedia` is not promise-based and historically needs a tab context; if the service
  worker call errors we open `popup.html?mode=pick` as a tab and call it there. `targetTab` must be the extension
  page tab so the resulting streamId is redeemable by the extension origin (the offscreen document).
- Desktop capture deliberately does **not** capture audio (avoids loopback feedback in meetings). Audio for the
  meeting keeps coming from the user's real mic; `inject.js` merges the meeting's own mic request with our video.
- A tab captured by `tabCapture` is muted locally by Chrome while captured; that is Chrome, not a bug.
- Self-view is mirrored by Meet/Zoom's CSS, so text in the PiP self-view looks flipped to the local user but is
  correct for everyone else.
- `Browser.grantPermissions` only takes effect while the CDP session that sent it stays open. Closing the browser
  websocket right after the reply drops the override, and the failure looks like `NotAllowedError: Permission
  dismissed` from the offscreen document (i.e. a prompt nobody answered). Keep one browser session for the run.
- Chrome's desktop picker is browser chrome: `wmctrl` does not list it, CDP has no target for it, and it has no
  window of its own. To see it, grab the Chrome window (`xwd -id $(wmctrl -l | grep "Chrome for Testing" ...)`) and
  convert with `ffmpeg`. Keyboard input to it works with `xdotool key --window <id>`, mouse clicks by coordinates do
  not (and the Share button stays disabled until a source row is selected).
- `showError()` in `popup.js` must stay null-safe: `?mode=grant` and `?mode=pick` replace `#app`'s contents, so
  `#errorText` lives outside `#app` and any error slot may be absent.
- This project's absolute path contains a space, so any path passed to a shell command from the driver needs
  quoting (an unquoted `ffmpeg` output path fails silently).
- A background tab is not composited, so `Page.captureScreenshot` returns a blank frame. Call
  `Page.bringToFront` and wait before capturing a platform artifact (the driver retries once if the PNG is tiny).
- `run-test.sh` refuses to start when something already answers on the CDP port: a leftover Chrome otherwise
  makes the driver attach to the wrong browser and the failure looks like "our service worker never appeared".
- `dist/` is generated; never edit it by hand.
