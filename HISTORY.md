# HISTORY

Reverse-chronological log of what actually happened. Keep entries short and factual: what changed, what was
verified, what broke.

## 2026-11-24 — field report fixes: prompt-averse platforms, `"default"` alias, mirror toggle (51 pass / 0 fail / 0 skip)

First real-meeting report. Google Meet worked end to end (captured window as camera + PiP, badge `LIVE`). Webex
listed the virtual camera but turned video off when it was selected. Console from that session showed three
things worth fixing, and all three now have a suite check:

- Webex: `Cantina_AvoidGetUserMediaPromptError … avoidGetUserMediaPrompt is true` — it refuses to call
  `getUserMedia` while `navigator.permissions.query({name:"camera"})` says `prompt`. The shim now reports the
  **camera** permission as `granted` (it genuinely never prompts) and leaves microphone alone. Every platform
  check asserts `state === "granted"` (5 new PASSes).
- Webex: `No actualId found for alias device default. Using it as is` — it falls back to `deviceId: "default"`,
  which means the *real* default webcam. The shim now stands in for `"default"` **only when the machine has no
  real video input**, and the virtual camera is now the **first** video input rather than the last (new harness
  checks for both).
- Webex: each of its six attempts reached `[VTC:inject] Peer state … connected` with a live track and then
  `Virtual camera session stopped` — it stopped the track immediately. A track off a fresh receiver is `muted`
  until media arrives, so `inject.js` now waits (max 2.5 s) for `unmute`/first frame before resolving
  `getUserMedia`, the way a real camera hands over an already-live track.

Mirroring: the captured text looks backwards *in your own self-view* because Meet/Zoom mirror the local tile with
CSS; remote participants get the correct orientation. The "LIVE" pill is drawn into our own frame and was mirrored
too, which is the proof it is the page's self-view transform and not our pixels. Added a **Mirror output**
checkbox to the popup for people who want their own preview readable; it is off by default because it reverses
the feed for everyone else.

Implementation notes worth remembering:

- `chrome.storage` is **undefined in the offscreen document** (confirmed over CDP: `typeof chrome.storage ===
  "undefined"`). My first version called it at the top of `offscreen.js`, which threw before
  `chrome.runtime.onMessage` was registered — every `getUserMedia` then failed with `AbortError: Timed out
  connecting to the virtual camera` and the placeholder checks went red. The flag now lives in the service worker
  and is pushed to the compositor with `SET_MIRROR` (including on creation, so it survives restarts).
- New checks: first video input, camera permission `granted`, `"default"` alias, mirror flip (the PiP bubble must
  appear on the opposite side of the sampled frame), and the popup checkbox reaching the compositor through the
  real message path.
- `bash test/run-test.sh` → **51 passed, 0 failed, 0 skipped, exit 0**. Webex itself still needs a live re-test;
the three causes are evidenced in its console, not yet confirmed against a real Webex call.

## 2026-11-24 — real Google Meet page reached under automation (41 pass / 0 fail / 0 skip)

Meet is no longer checked on harness HTML served at its origin: the suite loads **Meet's own app** at
`https://meet.google.com/abc-defg-hij` and asserts against it. `bash test/run-test.sh` exits 0 with
**41 passed, 0 failed, 0 skipped**, including every earlier platform, the PiP pixel proof and the desktop picker.

### Was the signed-out wall automation detection? No.

- `curl -sS -D - https://meet.google.com/` → `HTTP/2 200`, **no `Location` header**. There is no server-side gate.
- Launched with `--disable-blink-features=AutomationControlled` and a normal desktop UA
  (`Mozilla/5.0 (X11; Linux x86_64) … Chrome/158.0.0.0 Safari/537.36`); measured `navigator.webdriver === false`.
  Still redirected, so the redirect is not automation detection.
- The redirect is Meet's own client-side bootstrap: `meet.google.com/` → `meet.google.com/about` →
  `apps.google.com/meet/` → `workspace.google.com/products/meet/` (200, marketing page, no meeting UI). The suite
  now records this chain and asserts it, so the "marketing page" result is evidence rather than a guess.
- `meet.google.com/new` → `accounts.google.com/v3/signin/identifier?continue=…meet.google.com/new…` (200). That
  surface is a genuine sign-in gate.

### What the real app does give us (all measured on this run's pages)

- `https://meet.google.com/abc-defg-hij` → **200, title "Meet"**, real bundle renders "Check your meeting code …".
  `[VTC:inject]` installs, the ISOLATED relay reports `true`, and the device list is
  `["(no label)","Screen / Tab + Cam (Virtual)"]`.
- On that page, `getUserMedia({video:{deviceId:{exact:"vtc-virtual-camera"}}})` returns a **live track** labelled
  "Screen / Tab + Cam (Virtual)" — the suite now asserts this (`readyState: live`, 640x360).
- Meet's join surface also renders its own prompt: "Do you want people to see and hear you in the meeting? / Use
  microphone and camera / Continue without microphone and camera" over a "Returning to home screen" spinner.
  `test/artifacts/meet-real.png` caught it; `meet-join-permission-prompt.png` is the investigation capture.
  Clicking it needs a valid code/account — and on a later load the prompt did not reappear at all, so it is
  transient and is documented rather than asserted.
- Meet's `_.mF` / `_.pRh` promise rejections come from `_/scs/mss-static/_/js/…MeetingsDesktopUi…`. A second Chrome
  **without the extension** threw the same ones, so the driver now filters exceptions by `chrome-extension://`
  URL/stack and reports "7 unrelated exception(s) from the site's own scripts" instead of failing.

### Test-harness fixes this pass

- Screenshots of a background tab came back blank (5.5 KB, pure white): `Page.captureScreenshot` needs the tab
  composited. The driver now calls `Page.bringToFront`, waits, and retries once if the PNG is under 20 KB —
  `meet-real.png` went from 5.5 KB blank to 66 KB of real Meet UI.
- "capture keeps a live frame rate" was flaky because it trusted the page's rolling average during encoder
  ramp-up. It now samples frames every 500 ms for 4 s: `8.0, 6.0, 14.0, 36.0, 34.0, 30.0, 36.0, 28.0` → 24 fps
  (steady 28-36 fps once warm). Assertion is ≥10 fps measured, not a rolling guess.
- A leftover Chrome from investigation work held CDP port 9222, so a run attached to it and reported "our
  service worker never appeared" with Meet's own `meetsw.js` in the target list. `run-test.sh` now refuses to
  start when something already answers on that port.

## 2026-11-24 — broad-platform coverage + both hands-off gaps closed (38 pass / 0 fail / 0 skip)

`bash test/run-test.sh` exits 0 in a headed Chrome for Testing 158 with the extension loaded. All five meeting
origins are checked on the real pages, the webcam overlay is asserted by pixels and shown in a screenshot, and
the desktop picker is exercised for real.

### Per-platform verification (what the suite actually proves)

| Platform | How the page was reached | Result |
| --- | --- | --- |
| Google Meet | `https://meet.google.com/abc-defg-hij`, harness HTML served **at that origin** via CDP request interception (see wall below) | shim installs in MAIN + ISOLATED, `vtc-virtual-camera` enumerates, no exceptions |
| Jitsi | organic `https://meet.jit.si/` | same |
| Zoom Web | organic `https://app.zoom.us/wc/home` → `/wc/` | same |
| Teams Web | organic `https://teams.microsoft.com/` → `/v2/` | same |
| Whereby | organic `https://whereby.com/` | same |

The "ISOLATED world" half of that check reads the content-script world as a separate CDP execution context
(`Runtime.executionContextCreated`, name = extension name, `auxData.type === "isolated"`) and evaluates
`!!window.__vtcRelayInstalled` inside it. `chrome.scripting.executeScript` is not usable here: without the `tabs`
permission the service worker cannot read `tab.url`, and scripting then refuses with
`Cannot access contents of the page. Extension manifest must request permission to access the respective host.`

### Where Meet's wall is (measured, not assumed)

- `https://meet.google.com/` → redirect to `https://workspace.google.com/products/meet/` (marketing page). Our
  content script correctly does not run there; the page was fine all along, the old suite just reported
  "never loaded" because it waited for the shim.
- `https://meet.google.com/landing` → redirect to
  `https://accounts.google.com/v3/signin/identifier?continue=https://meet.google.com/landing` (sign-in wall).
- `https://meet.google.com/?hs=197&authuser=0` → same marketing redirect.

So without a Google session there is no meeting/preview surface to load. The suite therefore fulfills the request
for `https://meet.google.com/*` with the harness HTML, which makes `location.origin` the real Meet origin: the
manifest match, content-script injection, MAIN-world `MediaDevices` patch, ISOLATED relay and device enumeration
are all exercised exactly as they will be on a real call. What it cannot exercise is Meet's own app code
(`getUserMedia` inside Meet's preview) — that needs a signed-in account, recorded in TODO.md as the one
human/account-gated item.

### Webcam PiP: the actual cause of the old SKIP

`Browser.grantPermissions` was being sent from a browser-level CDP session that was **closed immediately after
the reply**. The override was dropped before it committed, so the offscreen document kept seeing
`prompt`, `getUserMedia` raised a prompt that nobody could answer, and the error surfaced as
`NotAllowedError: Permission dismissed`. Keeping one browser session open for the whole run (and re-applying the
grant while polling `navigator.permissions.query({name:"camera"})` in the offscreen document) makes it stick.

Verified behaviour: permission `granted`, `SET_CAM` returns `{camEnabled:true, camError:null}`, and the bubble is
detected by pixels at the PiP centre of the frame — before `[71,0,69]` (captured tab), after `[143,140,144]`
(camera image), delta 140. `test/artifacts/harness-live.png` shows the captured tab with the LIVE badge and the
webcam bubble bottom-right.

### Desktop capture: real picker, proven, then cancelled

`chrome.desktopCapture.chooseDesktopMedia` is called for real from `popup.html?mode=pick` (it needs a page, not
the service worker). Chrome's picker is **browser chrome**: it has no CDP target and no X window of its own, so
`wmctrl` sees nothing and the page cannot be scripted. Evidence collected instead:

- the request stays `pending` while the picker is up (a rejected request would resolve immediately),
- `test/artifacts/desktop-picker.png` is an `xwd` grab of the Chrome window showing "Choose what to share" with
  Entire Screen / Window / Chromium Tab and Cancel/Share,
- pressing Escape on the window makes the callback fire with an empty id (`cancelled`), which is the extension's
  own cancel path, and the page reports no exceptions.

Selecting a source and pressing Share still needs a human click: `Share` stays disabled until a source row is
chosen, and under `--ozone-platform=x11` the portal supplies source names without thumbnails, so the tile is not
reliably clickable by coordinates. That is the only remaining human step in the desktop flow; the rest of the
pipeline (background `START_CAPTURE`, offscreen redemption of a desktop id, compositor, loopback) is the same code
path that the tab-capture tests already cover.

### Real bug fixed on the way

`showError()` threw `TypeError: Cannot set properties of null` in `?mode=pick` / `?mode=grant`, because those
modes replace `#app`'s innerHTML and the error element lived inside it. Any failure in the picker flow therefore
died silently. `#errorText` now lives outside `#app` and `showError()` is null-safe.

### Test harness changes

- `test/harness.html`: added `__vtcTest.sample(nx, ny)` so the driver can pixel-probe any point of the received
  frame (used for the PiP bubble).
- `test/driver.mjs`: per-platform checker with the Meet interception mode, CDP-based ISOLATED-world probe, PiP
  grant retry, PiP pixel assertion, desktop picker check with an X11 screenshot, and capture-dependent checks
  that degrade to SKIP when the keyboard gesture is unavailable (no focused X11 window).
- Screenshot paths are shell-quoted: this project path contains a space, which silently broke `ffmpeg` before.

## 2026-11-24 — v1 works end to end in a headed browser (23 checks pass)

Verified with `bash test/run-test.sh` against Chrome for Testing 158.0.8127.88 on this machine:

- virtual device `vtc-virtual-camera` enumerable, label `Screen / Tab + Cam (Virtual)`, 16:9 placeholder
  stream at ~20-30 fps before any capture;
- press Ctrl+Shift+Y (real extension invocation) -> `tabCapture` starts -> the captured tab's **actual pixels**
  arrive at the stand-in meeting page (pixel probe turns green), badge `LIVE`, status reports `sourceType:"tab"`;
- stop -> placeholder returns, badge clears;
- popup status chain (popup -> background -> offscreen) renders `Idle`, no exceptions;
- shim installs on meet.jit.si, app.zoom.us/wc, whereby.com (virtual device listed on those origins);
  meet.google.com was reported as "never loaded" — the real cause is documented in the entry above.

### The snag we chased for a long time, and what it actually was

Tab capture kept failing with `NotFoundError: Requested device not found` when a `tabCapture` stream id was
redeemed with `getUserMedia({video:{mandatory:{chromeMediaSource:"tab",chromeMediaSourceId:...}}})`, in the
offscreen document, in `popup.html` opened as a tab, and even in the *same page* that created the id. A failed
redemption also permanently locks the tab (`Cannot capture a tab with an active stream`) until it is reloaded.

Cause: **our own test flags**. `--use-fake-ui-for-media-stream` (and the fake device flag) make Chrome's fake
media UI regime swallow `chromeMediaSource: "tab"` requests, so no id is ever redeemable. Removing the flags made
the exact same code work on the first try (1922x1080 real tab frames). The documented architecture
(popup/service worker creates the id -> offscreen document redeems it) was correct all along.

### Other fixes from that round

- Compositor frames: `canvas.captureStream()` emits essentially one frame in a hidden offscreen document, so the
  compositor writes `VideoFrame(canvas)` into a `MediaStreamTrackGenerator` at 30 fps. The draw loop keeps running
  when capture stops, so the meeting shows the "ready" card again instead of a frozen last frame.
- WebRTC: the transceiver is created *after* `setRemoteDescription`, otherwise Chrome answers a second, inactive
  m-line and the page receives nothing; answer `sendonly`, sender tuned to `maintain-resolution`.
- Harness/relay: the page can only see MAIN-world globals, so the driver waits on `window.__vtcRelayReady`.
- `PORT=0` in the environment used to break `serve.mjs`/`run-test.sh`; it is now normalised to 8123.

## 2026-11-24 — v1 scaffold

- Read the design doc (`chat-building-a-virtual-tab-camera-google-ai-studio-2026-11-24-1231.md`): an AI Studio
  conversation that evolved a 6-file MV3 pipeline (manifest, background, offscreen, relay, inject) and then added
  a popup with window/screen sharing and a webcam PiP overlay.
- Confirmed the environment: Debian Linux, Chrome for Testing downloaded by `test/fetch-chrome.sh` (branded
  Chrome 158 silently ignores `--load-extension`), bun for the harness.
- Wrote AGENTS.md, TODO.md, HISTORY.md before any code, per the project mission.
- Implemented the extension under `extension/`, keeping the doc's architecture but fixing/adding:
  - prototype-level `MediaDevices` patching (instance patch alone is bypassable), idempotent injection guard
  - relay hello/ready handshake so a missing relay fails fast with a clear message instead of a 5s mystery hang
  - `Promise.allSettled` audio+video merge so a mic failure does not leak the virtual video track
  - track `label`/`getSettings`/`stop` overrides so platforms highlight the right device
  - "Enable on this page" one-shot injection for platforms that are not in the match list (self-hosted Jitsi)
  - popup shows capture errors instead of failing silently
  - a `toggle-share` command (Ctrl+Shift+Y) that captures the active tab without opening the popup
- Added a dev harness (`test/`) that loads the extension in a headed Chrome and drives it over CDP.
