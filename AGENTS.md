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
4c. **The offscreen document has no `chrome.storage`** (`typeof chrome.storage === "undefined"` there — verified
   over CDP). Settings the compositor needs are persisted in the service worker and pushed in with `SET_MIRROR`.
   Never call `chrome.storage` from `offscreen.js`, and keep the `chrome.runtime.onMessage` registration above
   optional setup: a throw before it silently removes the offer handler and every `getUserMedia` then times out.
5. **Webcam permission belongs to the extension origin.** Offscreen documents cannot prompt, so the user grants
   camera access on a real extension page (`popup.html?mode=grant`). Keep the grant flow.
5b. **A camera request that names no device is ours.** Platforms ask in two shapes: an explicit
   `deviceId` (Meet, Zoom) or just `{video:{width,height,frameRate}}` / `deviceId:"default"` (Jitsi, Webex).
   The second shape means "Chrome's default camera", i.e. the physical webcam this extension exists to
   replace, so `inject.js` serves the virtual camera for it. A request that names a *different* concrete
   device still goes to the real camera, so picking your webcam in a platform's menu keeps your webcam.
   Removing this is what made Jitsi show its own fallback and never start our track.
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
index.html            GitHub Pages landing page (self-contained: inline CSS, JSON-LD)
robots.txt            crawl rules for the Pages site
sitemap.xml           single-URL sitemap for the Pages site
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
- Every platform check also asserts `navigator.permissions.query({name:"camera"}).state === "granted"`, because
  that is what makes prompt-averse platforms (Webex) call `getUserMedia` at all.
- The harness additionally asserts that the virtual camera is the **first** video input, that a
  `deviceId: "default"` request reaches it on a machine without a real webcam, and that the mirror flag moves the
  webcam bubble to the opposite side of the received frame (sampled through `__vtcTest.sample`). The popup's
  checkbox is clicked through CDP to prove the popup → background → compositor path.
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
- Platforms that refuse to call `getUserMedia` while it would prompt (Webex: `Cantina_AvoidGetUserMediaPromptError
  … avoidGetUserMediaPrompt is true`) need `navigator.permissions.query({name:"camera"})` to report `granted`.
  The shim reports that for the camera only — the virtual camera genuinely never prompts — and leaves microphone
  alone so the real prompt still appears.
- `deviceId: "default"` is Chrome's alias for the default camera; Webex logged `No actualId found for alias
  device default` before giving up on video. The shim now answers any camera request that names no device or
  names `"default"` with the virtual camera (invariant 5b) — that is "the default camera", which this extension
  replaces. A request naming a *different* concrete device still goes native, so a webcam picked in a platform's
  own menu keeps working.
- A track straight off a fresh receiver is `muted` until media arrives. Webex stopped ours immediately after
  `connected`, so `inject.js` waits (max 2.5 s) for `unmute`/first frame before resolving `getUserMedia`; a real
  camera hands over an already-live track.
- Meet and Zoom mirror your own self-view with CSS, so shared text reads backwards **to you** while everyone else
  sees it the right way round. The popup's "Mirror output" checkbox flips the composited frame for users who want
  their own preview readable; it reverses the feed for everyone else, so it is off by default.
- `degradationPreference` is **not** a property of `RTCRtpSender`; assigning it there is a silent no-op. It must
  go through `sender.setParameters({...params, degradationPreference: "maintain-resolution"})`. Before that fix
  Chrome downscaled the compositor's 1280x720 to **320x180** on the loopback (measured on a real Jitsi room);
  after it the page receives 1280x720.
- A real Jitsi join cannot be automated inside `run-test.sh`: `meet.jit.si` rooms need a signed-in moderator to
  clear the lobby, and the Jitsi deployment used for the manual check (`meet.ffmuc.net`) is not in the shipped
  match list, so it needs the popup's "Enable on this page". Jitsi's own state is readable from the page:
  `APP.store.getState()["features/base/tracks"]` for the local track and
  `APP.conference._room.rtc.peerConnections` (a **Map**) for `outbound-rtp` stats. Its in-call camera picker is
  `select#videoInput` under Settings → Video.
- **Webex live recipe (no account needed).** `webex.com/test-meeting.html` → remove the OneTrust overlay
  (`#onetrust-consent-sdk`, `.onetrust-pc-dark-filter`) → set `#full-name` and `#email-address` with the native
  value setter (typing with `Input.insertText` after a programmatic fill appends and the site answers "Please
  enter a valid email address") → click `a.form_button`. The submit opens
  `join-test.webex.com/wbxmjs/joinservice/sites/join-test/meeting/download/<id>?ST=SUCCESS` in its own tab; click
  **Join from browser** (not "this browser"), then the web client loads in `#unified-webclient-iframe` on
  `web.webex.com/meeting`. That iframe is same-process but cross-origin, so read it through its own CDP execution
  context (`Runtime.executionContextCreated`, origin `web.webex.com`), and walk shadow roots — its buttons live
  inside custom elements, so a plain `document.querySelectorAll("button")` comes back empty while the surface is
  clearly rendered.
- **A solo Webex meeting does not upload.** In a guest test meeting with nobody else, Webex's own peer connection
  is `connected` with every transceiver `recvonly` and empty senders, so `outbound-rtp` reports 0 video frames,
  0 video bytes and 0 audio bytes for as long as you watch — while its own call tile renders our 1280×720 frames.
  That is the platform, not the shim: do not go hunting for a pipeline bug when audio is at zero too. A second
  guest is gated by `web.webex.com/guest-enter-password-captcha` (clean profile *and* second tab), i.e. human-only.
- **Zoom Web has no credential-free meeting.** `zoom.us/test` → "Join a Test Meeting" → `Join` lands on
  `zoom.us/join` (Meeting ID / Personal Link only), and `app.zoom.us/wc/<id>/join` answers "This meeting link is
  invalid (3,001)". Its join surfaces still inject the shim and enumerate `vtc-virtual-camera` first, so the
  blocked part is the meeting id, not the extension. Zoom requests the camera with an explicit `deviceId`, so it
  uses the device list rather than the `"default"` alias rule.
- `dist/` is generated; never edit it by hand.

## Landing page (GitHub Pages)

GitHub Pages is enabled for `main` at the repository **root** (not `/docs`), so the home page is the root
`index.html`. Keep it one self-contained file: inline CSS, inline SVG favicon, no build step, no external fonts or
scripts, no `docs/` folder. It has to work served as plain static files from the repo root.

- Audience is presenters who are not host or co-host and so cannot use the meeting's screen share. Copy answers
  their question ("can I present at all?") instead of describing the architecture.
- **Beta status is load-bearing.** "Beta" appears in the header pill, the hero notice and the platform table, and
  the copy says the Chrome Web Store listing comes after every primary platform passes a live call. Do not
  soften that until a store listing actually exists.
- The platform table must match the verdicts in TODO.md/HISTORY.md: a platform moves from "Join pages" to
  "Live meeting"/"Live call" only when a real meeting produced the recorded evidence. No store availability, user
  counts, or unmeasured platforms.
- SEO/AEO is deliberate: one `<h1>`, question-shaped `<h3>`s each answered in one paragraph, a status table,
  `SoftwareApplication` + `WebSite` + `FAQPage` JSON-LD kept in sync with the visible FAQ text, canonical URL,
  OG/Twitter tags, plus `robots.txt` and `sitemap.xml` at the root.
- Blue-and-white minimalism: `#1d4ed8` on white with slate text and hairline rules, no images. The hero "meeting
  mock" (LIVE badge, slide, webcam bubble, camera picker) is CSS only, so there are no screenshot assets to
  maintain — and `test/artifacts/` is gitignored anyway.
- Live at https://spuds0588.github.io/Screen-as-Virtual-Camera-Extension/ — published from `main`, so a push
  deploys. Confirm with `gh api repos/Spuds0588/Screen-as-Virtual-Camera-Extension/pages` after pushing.
