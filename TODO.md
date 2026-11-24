# TODO

Living checklist for v1. Update this file as work lands (move items between sections, keep it honest).

Current state: `bash test/run-test.sh` → **51 passed, 0 failed, 0 skipped, exit 0** in a headed Chrome for
Testing 158 with the extension loaded. Artifacts: `test/artifacts/results.json`, `harness-live.png`,
`desktop-picker.png`, `meet-real.png` (the real Meet page the suite reached), plus
`meet-join-permission-prompt.png` from the investigation of that page.

## Verified per platform (shim in both worlds + `vtc-virtual-camera` enumerates + no exceptions)

| Platform | Page | Notes |
| --- | --- | --- |
| Google Meet | `https://meet.google.com/abc-defg-hij` | **real Meet app, no interception**: 200, title "Meet", renders "Check your meeting code" and its own camera/mic prompt. Also asserts the shim camera opening via the page's own `getUserMedia`. `meet.google.com/` answers 200 and client-side navigates to `workspace.google.com/products/meet/`; `/new` and `/landing` go to `accounts.google.com` sign-in |
| Jitsi | `https://meet.jit.si/` | organic load |
| Zoom Web | `https://app.zoom.us/wc/home` | organic load, redirects to `/wc/` |
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
- **Webex (`web.webex.com`) — detected the camera, then turned video off.** Console evidence from that session:
  the shim installed, Webex asked for the virtual camera six times, each peer reached `connected` with a live
  track, and Webex called `track.stop()` immediately afterwards; Webex also logged
  `Cantina_AvoidGetUserMediaPromptError … avoidGetUserMediaPrompt is true` and
  `No actualId found for alias device default`. Three fixes shipped and are covered by the suite: camera
  permission now reports `granted`, the `"default"` alias reaches the virtual camera when the machine has no real
  webcam, and the track is handed over only once it is unmuted. **Not yet re-tested in a real Webex meeting.**
- Resolution: the compositor is 1280x720 @ 30 fps, sender capped at 2.5 Mbps with `maintain-resolution`. Most
  softness seen in the field is the platform's own downscale of a mostly-static screen; if a call looks soft,
  check `chrome://webrtc-internals` on the sending side before changing the pipeline.

## Still needs a human (nothing else is blocked)

- [ ] **Choose a desktop source and press Share.** `Share` is disabled until a source row is selected, the picker
      is Chrome browser chrome (no CDP target, no X window) so it cannot be clicked programmatically here, and
      under `--ozone-platform=x11` the portal lists sources without thumbnails. Everything after that click
      (`START_CAPTURE` with `sourceType:"desktop"`, offscreen redemption, compositor, loopback) is the same code
      path the tab tests cover. Evidence: `test/artifacts/desktop-picker.png`.
- [ ] **Re-test Webex / Zoom Web / Teams Web in a live meeting** after the Webex fixes (camera permission
      `granted`, `"default"` alias fallback, unmute-before-hand-over). If Webex still drops the track, capture its
      console plus `webrtc-internals` and compare the requested constraints with what the shim serves.
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

## Open questions

- [ ] Do Meet's iframes (blob: frames, `all_frames: true`) pick up the patched `MediaDevices`, or does only the
      main frame need it? Jitsi/Zoom/Teams/Whereby pass with the main-frame patch.
- [ ] Does Meet's join-surface camera/mic prompt lead anywhere without an account (it appears intermittently and
      vanished before it could be clicked in this pass), or does any click just return to the home screen?
- [ ] Does the desktop picker ever render source thumbnails under X11 here (portal), or is the missing thumbnail
      specific to Chrome for Testing on this machine?
