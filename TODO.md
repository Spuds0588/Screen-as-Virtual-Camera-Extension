# TODO

Living checklist for v1. Update this file as work lands (move items between sections, keep it honest).

Current state: `bash test/run-test.sh` → **52 passed, 0 failed, 0 skipped, exit 0** in a headed Chrome for
Testing 158 with the extension loaded. Artifacts: `test/artifacts/results.json`, `harness-live.png`,
`desktop-picker.png`, `meet-real.png` (the real Meet page the suite reached), plus
`meet-join-permission-prompt.png` from the investigation of that page.

## Verified per platform (shim in both worlds + `vtc-virtual-camera` enumerates + no exceptions)

| Platform | Page | Notes |
| --- | --- | --- |
| Google Meet | `https://meet.google.com/abc-defg-hij` | **real Meet app, no interception**: 200, title "Meet", renders "Check your meeting code" and its own camera/mic prompt. Also asserts the shim camera opening via the page's own `getUserMedia`. `meet.google.com/` answers 200 and client-side navigates to `workspace.google.com/products/meet/`; `/new` and `/landing` go to `accounts.google.com` sign-in |
| Jitsi | `https://meet.jit.si/` | organic load |
| Zoom Web | `https://app.zoom.us/wc/home` | organic load, redirects to `/wc/`. Join surface (modal `#join-meeting-modal-meeting-id`, `/wc/<id>/join`) injects and enumerates the virtual camera, but no meeting can be joined without a meeting id — **live-session verdict blocked, see below** |
| Webex | `https://web.webex.com/meeting` (inside `join-test.webex.com`, and `webex.com/test-meeting.html`) | **live guest meeting reached, no account needed** — the meeting ran on the virtual camera at 1280×720, Webex's own transport stayed `recvonly` because it was alone, see field reports |
| Teams Web | `https://teams.microsoft.com/` | organic load, redirects to `/v2/` |
| Whereby | `https://whereby.com/` | organic load |

- [x] AGENTS.md / TODO.md / HISTORY.md scaffolding
- [x] `manifest.json` (MV3, popup action, MAIN+ISOLATED content scripts, broad match list, `toggle-share` command)
- [x] `background.js` (offscreen lifecycle, capture start/stop, status, relay routing, badge, desktop picker)
- [x] `popup.html` / `popup.js` (status, share tab, share screen/window, webcam PiP toggle, stop, enable-on-page,
      camera grant page)
- [x] `offscreen.html` / `offscreen.js` (WebCodecs frame source, placeholder card, tab+desktop+webcam sources,
      loopback WebRTC, 1280x720 letterbox)
- [x] `inject.js` / `relay.js` (MAIN-world patch, ISOLATED bridge, handshake, track overrides)
- [x] Test harness + headed-browser suite (`test/`)
- [x] Virtual device enumerable before capture; placeholder stream 16:9 at ~20-30 fps
- [x] Real tab capture reaches the page (pixel probe), badge `LIVE`, status `sourceType:"tab"`
- [x] Stop returns the placeholder feed and clears the badge
- [x] Popup status chain renders correctly, no exceptions
- [x] **Webcam PiP**: permission granted for the extension origin, overlay composited (pixel delta 140 at the
      bubble centre), screenshot `test/artifacts/harness-live.png`
- [x] **Share Screen / Window**: real `chrome.desktopCapture.chooseDesktopMedia` opens Chrome's "Choose what to
      share" picker (screenshot `test/artifacts/desktop-picker.png`), the request stays pending, Escape cancels it
      and the extension's callback reports cancellation
- [x] Found the real causes of the old failures: `--use-fake-ui-for-media-stream` breaks tab-capture redemption;
      a browser-level CDP session closed too early drops the camera permission override; `showError()` crashed in
      the picker/grant modes (all fixed)

## Field reports (real meetings, not the harness)

- **Google Meet — working.** Screenshots from a live call show the captured window as the camera feed with the
  webcam PiP composited in the corner, badge `LIVE`, and both the captured tab and the PiP rendering in Meet.
  Text looks mirrored **in your own self-view only** (Meet mirrors the local tile with CSS); remote participants
  see it correctly. `test/artifacts/` keeps the harness proof; the user's call screenshots are the field proof.
- **Jitsi — verified end to end in a real call (2026-11-24).** Room
  `https://meet.jit.si/wowletstestthatchromeextension`, two participants, extension loaded. The room's own state
  showed the local camera track as `deviceId: vtc-virtual-camera`, label "Screen / Tab + Cam (Virtual)",
  `readyState: live`, `enabled: true`, `muted: false`, track settings 1280x720, and Jitsi's `outbound-rtp` video
  stats climbed 0 → **268 frames over 30 s** (~9 fps sent) at 640x360, targetBitrate 300 kbps,
  `qualityLimitationReason: none`. Screenshot: the call tile is the compositor's "Virtual Camera Ready" card.
  Two implementation bugs were found and fixed by this test: Jitsi asks for a camera **without a `deviceId`**
  (the shim skipped it and Chrome handed over the physical webcam) and the loopback sender set
  `degradationPreference` as a property instead of via `setParameters`, so Chrome downscaled our 1280x720 to
  320x180. Jitsi's sent resolution (640x360 @ 300 kbps) is Jitsi's own adaptive output for a 1:1 call, not our
  publish setting.
- **Webex — verified in a live meeting (2026-11-24).** Reached a real Webex meeting with no account:
  `webex.com/test-meeting.html` → name + email → `join-test.webex.com/…/meeting/download/<id>` → "Join from
  browser" → `web.webex.com/meeting` → name, "Start video", "Join meeting". In the meeting Webex's own `<video>`
  tiles were 1280×720 and its track was `deviceId: vtc-virtual-camera`, label "Screen / Tab + Cam (Virtual)",
  `readyState: live`, `enabled: true`, `muted: false`; the self-view showed the compositor's "Virtual Camera
  Ready" card. Webex's own peer connection was `connected` with **all transceivers `recvonly`** and 24 empty
  senders, so `outbound-rtp` stayed at 0 video frames / 0 bytes (and 0 audio bytes) across 35 s: Webex does not
  upload while it is the only participant. A second guest is gated by
  `web.webex.com/guest-enter-password-captcha` in both a clean profile and a second tab, so the publishing half
  of the evidence needs the user. The three fixes from the earlier field report (camera permission `granted`,
  `"default"` alias served, unmute-before-hand-over) all held in this meeting.
- **Zoom Web — blocked on a meeting id (2026-11-24).** `zoom.us/test` ("Test your internet connection by joining
  a test meeting") sends its `Join` to `zoom.us/join`, which only accepts a Meeting ID / Personal Link;
  `app.zoom.us/wc/1234567890/join` answers **"This meeting link is invalid (3,001)"**; hosting needs sign-in.
  Zoom's join surfaces still inject the shim, enumerate `vtc-virtual-camera` first and report the camera
  permission as `granted`, so nothing failed on our side — there was no meeting to join.
- Resolution: the compositor is 1280x720 @ 30 fps, sender capped at 2.5 Mbps with `maintain-resolution`. Most
  softness seen in the field is the platform's own downscale of a mostly-static screen; if a call looks soft,
  check `chrome://webrtc-internals` on the sending side before changing the pipeline.

## Still needs a human (nothing else is blocked)

- [ ] **Choose a desktop source and press Share.** `Share` is disabled until a source row is selected, the picker
      is Chrome browser chrome (no CDP target, no X window) so it cannot be clicked programmatically here, and
      under `--ozone-platform=x11` the portal lists sources without thumbnails. Everything after that click
      (`START_CAPTURE` with `sourceType:"desktop"`, offscreen redemption, compositor, loopback) is the same code
      path the tab tests cover. Evidence: `test/artifacts/desktop-picker.png`.
- [ ] **Webex: a second participant (publishing half of the evidence).** Webex negotiates its meeting transport
      `recvonly` while it is alone, so `outbound-rtp` cannot climb in a solo guest test meeting. A second guest
      always hits `https://web.webex.com/guest-enter-password-captcha` (confirmed from a clean Chrome profile and
      from a second tab of the same profile), which needs a human captcha or a Webex account. Join the same
      `join-test.webex.com` meeting from a signed-in Webex account and Webex will publish; expect the camera track
      already proven above (`vtc-virtual-camera`, 1280×720).
- [ ] **Zoom Web: a meeting id.** No credential-free Zoom meeting exists (`zoom.us/test` → `zoom.us/join`;
      `app.zoom.us/wc/<id>/join` → "This meeting link is invalid (3,001)"). Supply a Zoom meeting ID/link that
      admits guests (or a Zoom account to host), then run the same harness used for Jitsi: read
      `outbound-rtp` from the page's own `RTCPeerConnection` and check the self-view. Zoom asks for a camera with an
      explicit `deviceId`, so the shim's device list — not its alias rule — is what it will use.
- [x] **A real Google Meet call.** Done by the user on 2026-11-24: Meet offered "Screen / Tab + Cam (Virtual)",
      the captured window reached the call with the webcam PiP composited in, and the badge showed `LIVE`. The
      automation suite keeps the non-human half (shim + enumeration + a live `getUserMedia` track on the real
      `/abc-defg-hij` page).

## Next

- [ ] Long-session test (>10 min) to confirm the offscreen interval is not throttled and frames keep flowing
- [ ] Check the negotiated loopback resolution: the peer settles at 320x180/480x270 for a mostly-static card
      (content is composited at 1280x720). Confirm it ramps up with moving content; if not, tune the sender
      (bitrate/degradation) so meetings receive full resolution
- [ ] Verify audio behaviour in a real call: the meeting mic must keep working while the virtual camera runs

## Known gaps for v1.1 (deliberately not built yet)

- [ ] Persistent per-site enablement for self-hosted Jitsi/BigBlueButton domains (currently one-shot
      "Enable on this page" per page load; a navigation needs another click)
- [ ] `chrome.scripting.registerContentScripts` + `optional_host_permissions` for the above
- [ ] Audio from the captured tab (optional, opt-in; risks feedback loops in meetings)
- [ ] Region/crop selection for the shared source (currently whole source, letterboxed into 1280x720)
- [ ] Webcam PiP position/size/round-vs-square options
- [ ] Icons (currently no `icons` key; Chrome uses a generic puzzle icon)
- [ ] Keyboard-only flow + accessibility pass on the popup
- [ ] Firefox `browser.*` port (out of scope: `tabCapture`/offscreen are Chrome-only today)

### Considered, not built: un-flip our own self-view

Meetings mirror the local tile with CSS, so the presenter's own preview reads backwards while recipients get the
correct orientation (confirmed on Meet/Jitsi; Jitsi does it with the `flipVideoX` class). Un-flipping it locally is
possible without touching the feed and without platform selectors: `inject.js` already holds the `MediaStream` it
returned, so our tile is the `<video>` whose `srcObject` — or one of whose tracks — is that stream. For each match,
read the net horizontal scale from `getComputedStyle()` on the element and its ancestors; when it is negative,
counter-flip with an inline `!important` transform (inline beats an author stylesheet `!important`) and re-apply on
DOM mutations. Rendering stays local, so recipients are unaffected, and it needs no manifest or permission change.

Why it is not v1: the mirror is deliberate UX (your own gestures feel natural), so it needs its own toggle, not a
replacement for "Mirror output"; each platform's DOM still needs a live-call check (shadow roots, tile re-render,
some platforms may reuse/clone the track); and a platform that flips pixels rather than CSS would be uncovered. It
must degrade to "do nothing" when no net flip is detected. If it ships, the landing page's "Why does my own video
look mirrored?" FAQ changes too.

## Distribution / landing page

- [x] GitHub Pages home page at the repo root (`index.html`): blue-and-white minimalism, beta status stated up
      front, verified-platform table, privacy section, presenter FAQ. `robots.txt`, `sitemap.xml`, canonical +
      OG/Twitter tags, and `SoftwareApplication` + `WebSite` + `FAQPage` JSON-LD for SEO/AEO.
- [ ] Chrome Web Store listing — **only after every primary target passes a live call.** Blocked on the open
      items above (Zoom Web meeting id, Webex second participant) plus a live call on Teams Web and Whereby.
- [ ] Store assets for that listing: 128×128 icon, screenshots, promo tile. The extension still has no `icons`
      key, so Chrome shows a generic puzzle piece; the landing page uses an inline SVG favicon instead.
- [ ] Keep the landing page's platform table in step with HISTORY.md whenever a verdict changes.

## Open questions

- [ ] Do Meet's iframes (blob: frames, `all_frames: true`) pick up the patched `MediaDevices`, or does only the
      main frame need it? Jitsi/Zoom/Teams/Whereby pass with the main-frame patch.
- [ ] Does Meet's join-surface camera/mic prompt lead anywhere without an account (it appears intermittently and
      vanished before it could be clicked in this pass), or does any click just return to the home screen?
- [ ] Does the desktop picker ever render source thumbnails under X11 here (portal), or is the missing thumbnail
      specific to Chrome for Testing on this machine?
