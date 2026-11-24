// [VTC:inject] MAIN world. Adds the virtual camera device and serves it from the offscreen compositor.
(() => {
  "use strict";

  if (window.__vtcInjected) return;
  if (!navigator.mediaDevices || !window.MediaDevices) {
    console.warn("[VTC:inject] mediaDevices unavailable, virtual camera not installed");
    return;
  }
  window.__vtcInjected = true;

  const VIRTUAL_ID = "vtc-virtual-camera";
  const VIRTUAL_LABEL = "Screen / Tab + Cam (Virtual)";
  const VIRTUAL_GROUP = "vtc-virtual-group";
  const RELAY_TIMEOUT_MS = 2000;
  const CONNECT_TIMEOUT_MS = 8000;

  const NativeRTCPeerConnection = window.RTCPeerConnection;
  const pendingRequests = new Map(); // requestId -> { pc, pendingIce, remoteSet, onAnswer, onIce }
  let relayReady = false;
  const relayWaiters = new Set();

  console.log("[VTC:inject] Virtual camera shim installed on", location.origin);

  /* ------------------------------------------------------------ relay handshake */

  function makeId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function sendToOffscreen(payload) {
    window.postMessage({ source: "vtc-inject", payload }, "*");
  }

  function waitForRelay() {
    if (relayReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        relayWaiters.delete(finish);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), RELAY_TIMEOUT_MS);
      relayWaiters.add(finish);
      sendToOffscreen({ type: "VTC_HELLO" });
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "vtc-relay" || !data.payload) return;
    const payload = data.payload;

    if (payload.type === "VTC_RELAY_READY") {
      relayReady = true;
      for (const waiter of [...relayWaiters]) waiter(true);
      return;
    }

    const request = pendingRequests.get(payload.requestId);
    if (!request) return;

    if (payload.type === "WEBRTC_ANSWER") request.onAnswer(payload.answer);
    else if (payload.type === "OFFSCREEN_ICE") request.onIce(payload.candidate);
  });

  /* ------------------------------------------------------------ device plumbing */

  function flattenDeviceIds(value, out) {
    if (!value) return out;
    if (typeof value === "string") {
      out.push(value);
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value) flattenDeviceIds(item, out);
      return out;
    }
    if (typeof value === "object") {
      flattenDeviceIds(value.exact, out);
      flattenDeviceIds(value.ideal, out);
    }
    return out;
  }

  function wantsVirtualCamera(videoConstraint) {
    if (!videoConstraint || typeof videoConstraint !== "object") return false;
    return flattenDeviceIds(videoConstraint.deviceId, []).includes(VIRTUAL_ID);
  }

  function attachTrackOverrides(track) {
    try {
      const nativeGetSettings = track.getSettings.bind(track);
      track.getSettings = () => {
        const settings = nativeGetSettings();
        return {
          ...settings,
          deviceId: VIRTUAL_ID,
          groupId: VIRTUAL_GROUP,
          width: settings.width || 1280,
          height: settings.height || 720,
          frameRate: settings.frameRate || 30
        };
      };
    } catch (err) {
      console.warn("[VTC:inject] Could not patch getSettings:", err.message);
    }

    try {
      track.getCapabilities = () => ({
        deviceId: VIRTUAL_ID,
        groupId: VIRTUAL_GROUP,
        width: { min: 320, max: 1280 },
        height: { min: 180, max: 720 },
        frameRate: { min: 1, max: 30 }
      });
    } catch {}

    try {
      track.applyConstraints = async () => undefined;
    } catch {}

    try {
      Object.defineProperty(track, "label", { get: () => VIRTUAL_LABEL, configurable: true });
    } catch {}
  }

  function connectToOffscreenStream() {
    return waitForRelay().then((available) => {
      if (!available) {
        throw new DOMException(
          "Virtual camera bridge did not answer. Reload the meeting page and try again.",
          "AbortError"
        );
      }

      return new Promise((resolve, reject) => {
        const requestId = makeId();
        const pc = new NativeRTCPeerConnection({ iceServers: [] });
        let timer = null;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          pendingRequests.delete(requestId);
          try {
            pc.close();
          } catch {}
        };

        const fail = (err) => {
          cleanup();
          reject(err);
        };

        let delivered = false;

        const handOver = (track) => {
          attachTrackOverrides(track);
          console.log("[VTC:inject] Virtual camera track received", requestId, track.readyState);

          const nativeStop = track.stop.bind(track);
          track.stop = () => {
            console.log("[VTC:inject] Virtual camera session stopped", requestId);
            nativeStop();
            cleanup();
          };

          resolve(new MediaStream([track]));
        };

        // A real camera hands over an unmuted track with frames already flowing. A track straight off
        // a fresh receiver is muted until media arrives, and some platforms treat that as a failed
        // camera (Webex stops the track immediately after `connected`), so wait for the first frame.
        const deliver = (track) => {
          if (delivered || !track) return;
          delivered = true;
          if (timer) clearTimeout(timer);

          if (!track.muted) {
            handOver(track);
            return;
          }

          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            clearTimeout(cap);
            track.removeEventListener("unmute", release);
            handOver(track);
          };
          const cap = setTimeout(() => {
            console.warn("[VTC:inject] Track still muted after 2.5s, handing it over anyway", requestId);
            release();
          }, 2500);
          track.addEventListener("unmute", release);
        };

        // Chrome does not fire `ontrack` when the receiving transceiver was created locally before
        // negotiation, so also hand over whatever track the receivers ended up with.
        const deliverFromReceivers = () => {
          const receiver = pc.getReceivers().find((r) => r.track);
          if (!receiver) return false;
          deliver(receiver.track);
          return true;
        };

        const request = {
          pc,
          pendingIce: [],
          remoteSet: false,
          onAnswer: async (answer) => {
            try {
              console.log("[VTC:inject] Answer received", requestId, answer && answer.type);
              await pc.setRemoteDescription(answer);
              request.remoteSet = true;
              console.log(
                "[VTC:inject] Remote answer applied",
                requestId,
                pc.signalingState,
                "receivers:",
                pc.getReceivers().filter((r) => r.track).length
              );
              for (const candidate of request.pendingIce) {
                await pc.addIceCandidate(candidate).catch(() => {});
              }
              request.pendingIce.length = 0;
              deliverFromReceivers();
            } catch (err) {
              console.error("[VTC:inject] setRemoteDescription failed:", err);
              fail(err);
            }
          },
          onIce: async (candidate) => {
            if (request.remoteSet) {
              await pc.addIceCandidate(candidate).catch(() => {});
            } else {
              request.pendingIce.push(candidate);
            }
          }
        };
        pendingRequests.set(requestId, request);

        timer = setTimeout(
          () => fail(new DOMException("Timed out connecting to the virtual camera", "AbortError")),
          CONNECT_TIMEOUT_MS
        );

        pc.addTransceiver("video", { direction: "recvonly" });

        pc.onicecandidate = (event) => {
          if (!event.candidate) return;
          sendToOffscreen({ type: "INJECT_ICE", requestId, candidate: event.candidate.toJSON() });
        };

        pc.onconnectionstatechange = () => {
          console.log("[VTC:inject] Peer state", requestId, pc.connectionState);
          if (pc.connectionState === "connected" && !delivered) deliverFromReceivers();
        };

        pc.ontrack = (event) => {
          console.log("[VTC:inject] ontrack", requestId, event.track.kind, event.track.readyState);
          deliver(event.track);
        };

        (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendToOffscreen({
              type: "WEBRTC_OFFER",
              requestId,
              offer: { type: offer.type, sdp: offer.sdp }
            });
          } catch (err) {
            fail(err);
          }
        })();
      });
    });
  }

  /* ------------------------------------------------------------ permissions */

  // The virtual camera never prompts, but Chrome still reports `prompt` for the page's camera
  // permission. Platforms that refuse to call getUserMedia when it would prompt (Webex logs
  // "Cantina_AvoidGetUserMediaPromptError ... avoidGetUserMediaPrompt is true") then never preview
  // the camera and switch video off. Only the camera is overridden: microphone still prompts for real.
  function patchPermissions() {
    const permissions = navigator.permissions;
    if (!permissions || typeof permissions.query !== "function") return;

    const nativeQuery = permissions.query.bind(permissions);
    function patchedQuery(descriptor) {
      const result = nativeQuery(descriptor);
      if (!descriptor || descriptor.name !== "camera") return result;
      return result.then((status) => {
        try {
          Object.defineProperty(status, "state", { get: () => "granted", configurable: true });
        } catch {}
        return status;
      });
    }
    patchedQuery.native = nativeQuery;

    try {
      permissions.query = patchedQuery;
    } catch (err) {
      console.warn("[VTC:inject] Could not patch navigator.permissions:", err.message);
    }
    try {
      if (window.Permissions) Permissions.prototype.query = patchedQuery;
    } catch {}
    console.log("[VTC:inject] Camera permission reported as granted for this page");
  }

  /* ------------------------------------------------------------ patched APIs */

  function patchedEnumerateDevices() {
    const nativeEnumerate = patchedEnumerateDevices.native;
    return Promise.resolve(nativeEnumerate.call(navigator.mediaDevices)).then((devices) => {
      const list = Array.from(devices);
      if (!list.some((device) => device.deviceId === VIRTUAL_ID)) {
        // First, not last: platforms that default to videos[0] (or a "default" alias resolved by
        // position) never reach a camera appended to the end of the list.
        list.unshift({
          deviceId: VIRTUAL_ID,
          kind: "videoinput",
          label: VIRTUAL_LABEL,
          groupId: VIRTUAL_GROUP,
          toJSON() {
            return {
              deviceId: this.deviceId,
              kind: this.kind,
              label: this.label,
              groupId: this.groupId
            };
          }
        });
      }
      return list;
    });
  }

  // Some platforms never name a device: Jitsi asks for `{video:{width,height,frameRate}}` and Webex
  // falls back to `deviceId: "default"`. Both mean "whatever camera Chrome has by default", which is
  // the physical webcam — the one thing this extension exists to replace. Those requests get the
  // virtual camera. A request that names a specific *other* device still goes to the real one, so a
  // user who picks their webcam in a platform's menu keeps getting their webcam.
  function wantsAnyCamera(video) {
    if (!video || typeof video !== "object") return false;
    const ids = flattenDeviceIds(video.deviceId, []);
    return ids.length === 0 || ids.includes("default");
  }

  async function patchedGetUserMedia(constraints) {
    const video = constraints && constraints.video;
    const virtualRequested = wantsVirtualCamera(video);
    if (!virtualRequested && !wantsAnyCamera(video)) {
      return patchedGetUserMedia.native.call(navigator.mediaDevices, constraints);
    }
    if (!virtualRequested) {
      console.log("[VTC:inject] Page asked for a camera without naming one; serving the virtual camera");
    }

    console.log("[VTC:inject] Intercepted getUserMedia for the virtual camera", constraints);
    const audio = constraints && constraints.audio;
    const audioPromise = audio
      ? patchedGetUserMedia.native.call(navigator.mediaDevices, { audio, video: false })
      : Promise.resolve(null);

    const [videoResult, audioResult] = await Promise.allSettled([connectToOffscreenStream(), audioPromise]);

    if (videoResult.status === "rejected") {
      if (audioResult.status === "fulfilled" && audioResult.value) {
        audioResult.value.getTracks().forEach((track) => track.stop());
      }
      console.error("[VTC:inject] Virtual camera failed:", videoResult.reason);
      throw videoResult.reason;
    }

    if (audioResult.status === "rejected") {
      videoResult.value.getVideoTracks().forEach((track) => track.stop());
      console.error("[VTC:inject] Microphone request failed:", audioResult.reason);
      throw audioResult.reason;
    }

    const tracks = [...videoResult.value.getVideoTracks()];
    if (audioResult.value) tracks.push(...audioResult.value.getAudioTracks());
    return new MediaStream(tracks);
  }

  const nativeEnumerate = MediaDevices.prototype.enumerateDevices || navigator.mediaDevices.enumerateDevices;
  const nativeGetUserMedia = MediaDevices.prototype.getUserMedia || navigator.mediaDevices.getUserMedia;

  patchedEnumerateDevices.native = nativeEnumerate.bind(navigator.mediaDevices);
  patchedGetUserMedia.native = nativeGetUserMedia;

  try {
    MediaDevices.prototype.enumerateDevices = patchedEnumerateDevices;
    MediaDevices.prototype.getUserMedia = patchedGetUserMedia;
  } catch (err) {
    console.warn("[VTC:inject] Could not patch MediaDevices.prototype:", err.message);
  }

  // Also shadow the instance, in case a page holds a reference or a wrapper replaced the prototype method.
  try {
    navigator.mediaDevices.enumerateDevices = patchedEnumerateDevices;
    navigator.mediaDevices.getUserMedia = patchedGetUserMedia;
  } catch (err) {
    console.warn("[VTC:inject] Could not patch navigator.mediaDevices:", err.message);
  }

  patchPermissions();

  // Probe the relay once at install so the popup/tests can see whether the bridge is alive.
  waitForRelay().then((ok) => {
    window.__vtcRelayReady = ok;
    if (!ok) console.warn("[VTC:inject] relay.js did not answer; the virtual camera will not work on this page");
  });

  console.log(`[VTC:inject] Virtual camera "${VIRTUAL_LABEL}" available as ${VIRTUAL_ID}`);
})();
