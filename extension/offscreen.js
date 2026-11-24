// [VTC:offscreen] Compositor: capture source + webcam -> canvas -> loopback WebRTC for the page shim.
//
// Frames are pushed with WebCodecs (MediaStreamTrackGenerator) rather than canvas.captureStream():
// an offscreen document is a hidden page, and a captured canvas there produces at most one frame
// because nothing is being rendered. MediaStreamTrackGenerator carries frames without rendering.

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const PIP_SIZE = 220;
const PIP_PAD = 28;
const MAX_BITRATE = 2_500_000;

let canvas = null;
let ctx = null;
let compositedStream = null;
let frameWriter = null;
let captureTrack = null;
let loopTimer = null;
let writingFrame = false;

let sourceStream = null;
let sourceVid = null;
let sourceType = null;

let camStream = null;
let camVid = null;
let camEnabled = false;
let camError = null;

let starting = false;
const peers = new Map(); // `${tabId}:${frameId}:${requestId}` -> { pc, pendingIce }

/* ------------------------------------------------------------------ compositor */

function ensureCompositedStream() {
  if (compositedStream) return compositedStream;

  canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  // Keep a drawing canvas out of the layout; frame capture never needs it painted on screen.
  ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  let track;
  if (typeof MediaStreamTrackGenerator === "function" && typeof VideoFrame === "function") {
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    frameWriter = generator.writable.getWriter();
    track = generator;
    console.log("[VTC:offscreen] Frame source: MediaStreamTrackGenerator (WebCodecs)");
  } else if (typeof canvas.captureStream === "function") {
    captureTrack = canvas.captureStream(FPS).getVideoTracks()[0];
    track = captureTrack;
    console.warn("[VTC:offscreen] Frame source: canvas.captureStream fallback (frames may stall while hidden)");
  } else {
    throw new Error("No way to produce video frames in this browser");
  }

  compositedStream = new MediaStream([track]);
  startFrameLoop();
  console.log(`[VTC:offscreen] Composited stream ready (${WIDTH}x${HEIGHT}@${FPS})`);
  return compositedStream;
}

function startFrameLoop() {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    drawFrame();
    pushFrame();
  }, 1000 / FPS);
}

function pushFrame() {
  if (captureTrack) {
    if (typeof captureTrack.requestFrame === "function") captureTrack.requestFrame();
    return;
  }
  if (!frameWriter || writingFrame) return;

  let frame;
  try {
    frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
  } catch (err) {
    console.warn("[VTC:offscreen] Could not snapshot the canvas:", err.message);
    return;
  }

  writingFrame = true;
  frameWriter
    .write(frame)
    .catch((err) => console.warn("[VTC:offscreen] Frame write failed:", err.message))
    .finally(() => {
      writingFrame = false;
      frame.close();
    });
}

function drawFrame() {
  if (!ctx) return;

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const hasSource = !!sourceVid && sourceVid.readyState >= 2 && sourceVid.videoWidth > 0;
  if (hasSource) {
    const scale = Math.min(WIDTH / sourceVid.videoWidth, HEIGHT / sourceVid.videoHeight);
    const dw = Math.round(sourceVid.videoWidth * scale);
    const dh = Math.round(sourceVid.videoHeight * scale);
    ctx.drawImage(sourceVid, Math.round((WIDTH - dw) / 2), Math.round((HEIGHT - dh) / 2), dw, dh);
  } else {
    drawPlaceholder();
  }

  drawPip();
  if (hasSource || camEnabled) drawLiveBadge();
}

function drawPlaceholder() {
  const t = Date.now() / 1000;
  ctx.textAlign = "center";

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 40px system-ui, -apple-system, sans-serif";
  ctx.fillText("Virtual Camera Ready", WIDTH / 2, HEIGHT / 2 - 24);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "22px system-ui, -apple-system, sans-serif";
  ctx.fillText("Open the extension popup to share a tab, window or screen", WIDTH / 2, HEIGHT / 2 + 26);

  const x = WIDTH / 2 - 140 + ((t * 60) % 280);
  ctx.fillStyle = "#334155";
  ctx.fillRect(WIDTH / 2 - 140, HEIGHT / 2 + 62, 280, 4);
  ctx.fillStyle = "#38bdf8";
  ctx.fillRect(x, HEIGHT / 2 + 60, 22, 8);
}

function drawPip() {
  if (!camVid || camVid.readyState < 2 || camVid.videoWidth === 0) return;

  const radius = PIP_SIZE / 2;
  const cx = WIDTH - radius - PIP_PAD;
  const cy = HEIGHT - radius - PIP_PAD;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.clip();
  // Cover-fit the webcam inside the circle.
  const scale = Math.max(PIP_SIZE / camVid.videoWidth, PIP_SIZE / camVid.videoHeight);
  const dw = camVid.videoWidth * scale;
  const dh = camVid.videoHeight * scale;
  ctx.drawImage(camVid, cx - dw / 2, cy - dh / 2, dw, dh);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 4;
  ctx.stroke();
}

function drawLiveBadge() {
  ctx.save();
  ctx.fillStyle = "rgba(15,23,42,0.72)";
  ctx.beginPath();
  ctx.roundRect(20, 20, 104, 36, 8);
  ctx.fill();
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(40, 38, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 17px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("LIVE", 56, 44);
  ctx.restore();
}

function detachVideo(vid) {
  if (!vid) return;
  try {
    vid.pause();
  } catch {}
  vid.srcObject = null;
}

/* ------------------------------------------------------------------ media sources */

function stopSource() {
  if (sourceStream) sourceStream.getTracks().forEach((track) => track.stop());
  detachVideo(sourceVid);
  sourceStream = null;
  sourceVid = null;
  sourceType = null;
}

function stopCam() {
  if (camStream) camStream.getTracks().forEach((track) => track.stop());
  detachVideo(camVid);
  camStream = null;
  camVid = null;
}

async function syncCam(enabled) {
  camEnabled = !!enabled;
  if (!camEnabled) {
    stopCam();
    camError = null;
    return { camEnabled, camError };
  }
  if (camStream) return { camEnabled, camError };

  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } }
    });
    camVid = document.createElement("video");
    camVid.muted = true;
    camVid.playsInline = true;
    camVid.srcObject = camStream;
    await camVid.play();
    camError = null;
    console.log("[VTC:offscreen] Webcam PiP started");
  } catch (err) {
    stopCam();
    camEnabled = false;
    camError = `${err.name}: ${err.message}`;
    console.warn("[VTC:offscreen] Webcam PiP unavailable:", camError);
  }
  return { camEnabled, camError };
}

async function handleSourceEnded() {
  console.log("[VTC:offscreen] Source track ended");
  stopSource();
  stopCam();
  camEnabled = false;
  chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_ENDED" }).catch(() => {});
}

async function startCapture(msg) {
  const mediaSource = msg.sourceType === "desktop" ? "desktop" : "tab";
  if (starting) console.warn("[VTC:offscreen] A capture start is already in flight");
  starting = true;
  console.log(`[VTC:offscreen] Starting ${mediaSource} capture (webcam PiP: ${!!msg.camEnabled})`);

  try {
    ensureCompositedStream();

    // Redeem the stream id Chrome handed to the background script. Audio is intentionally off.
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: mediaSource,
          chromeMediaSourceId: msg.streamId,
          maxFrameRate: FPS
        }
      }
    });

    stopSource();
    sourceStream = nextStream;
    sourceType = mediaSource;

    const [track] = sourceStream.getVideoTracks();
    if (track) track.onended = handleSourceEnded;

    sourceVid = document.createElement("video");
    sourceVid.muted = true;
    sourceVid.playsInline = true;
    sourceVid.srcObject = sourceStream;
    await sourceVid.play();

    console.log("[VTC:offscreen] Source attached", sourceVid.videoWidth + "x" + sourceVid.videoHeight);
    await syncCam(!!msg.camEnabled);

    return { ok: true, sourceType, camEnabled, camError };
  } finally {
    starting = false;
  }
}

/* ------------------------------------------------------------------ loopback WebRTC */

function relayToTab(tabId, frameId, payload) {
  chrome.runtime
    .sendMessage({ target: "background", type: "RELAY_TO_TAB", tabId, frameId, payload })
    .catch(() => {});
}

async function handleOffer(msg) {
  const connId = `${msg.tabId}:${msg.frameId}:${msg.requestId}`;
  console.log("[VTC:offscreen] WEBRTC_OFFER from", connId);

  const stream = ensureCompositedStream();
  const [videoTrack] = stream.getVideoTracks();

  const existing = peers.get(connId);
  if (existing) {
    try {
      existing.pc.close();
    } catch {}
    peers.delete(connId);
  }

  const pc = new RTCPeerConnection({ iceServers: [] });
  const entry = { pc, pendingIce: [] };
  peers.set(connId, entry);

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    relayToTab(msg.tabId, msg.frameId, {
      type: "OFFSCREEN_ICE",
      requestId: msg.requestId,
      candidate: event.candidate.toJSON()
    });
  };

  pc.onconnectionstatechange = () => {
    console.log("[VTC:offscreen] Peer state", connId, pc.connectionState);
    if (["failed", "closed"].includes(pc.connectionState)) {
      try {
        pc.close();
      } catch {}
      peers.delete(connId);
    }
  };

  await pc.setRemoteDescription(msg.offer);
  for (const candidate of entry.pendingIce) {
    await pc.addIceCandidate(candidate).catch(() => {});
  }
  entry.pendingIce.length = 0;

  // Attach the composited track to the m-line the page actually offered. Creating a transceiver
  // before applying the offer makes Chrome answer with a second, inactive m-line, so the page
  // receives no media at all.
  const transceiver =
    pc.getTransceivers().find((t) => t.receiver?.track?.kind === "video") ||
    pc.getTransceivers()[0] ||
    pc.addTransceiver("video", { direction: "sendonly" });

  transceiver.direction = "sendonly";
  await transceiver.sender.replaceTrack(videoTrack);

  try {
    const params = transceiver.sender.getParameters();
    if (params.encodings && params.encodings.length > 0) {
      params.encodings[0].maxBitrate = MAX_BITRATE;
      params.encodings[0].maxFramerate = FPS;
      params.encodings[0].priority = "high";
      await transceiver.sender.setParameters(params);
    }
    transceiver.sender.degradationPreference = "maintain-resolution";
  } catch (err) {
    console.warn("[VTC:offscreen] Could not tune the video sender:", err.message);
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  relayToTab(msg.tabId, msg.frameId, {
    type: "WEBRTC_ANSWER",
    requestId: msg.requestId,
    answer: { type: answer.type, sdp: answer.sdp }
  });

  return { ok: true };
}

async function handleIce(msg) {
  const entry = peers.get(`${msg.tabId}:${msg.frameId}:${msg.requestId}`);
  if (!entry) return { ok: true };
  if (entry.pc.remoteDescription) {
    await entry.pc.addIceCandidate(msg.candidate).catch((err) =>
      console.warn("[VTC:offscreen] addIceCandidate failed:", err.message)
    );
  } else {
    entry.pendingIce.push(msg.candidate);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ messaging */

async function handleOffscreenMessage(msg) {
  switch (msg.type) {
    case "GET_STATUS":
      return {
        active: !!sourceStream,
        sourceType,
        camEnabled,
        camError,
        peers: peers.size,
        width: WIDTH,
        height: HEIGHT,
        frameRate: FPS
      };

    case "START_CAPTURE":
      return startCapture(msg);

    case "SET_CAM": {
      const result = await syncCam(!!msg.camEnabled);
      return { ok: true, ...result };
    }

    case "STOP_CAPTURE":
      console.log("[VTC:offscreen] Stopping capture source and webcam");
      stopSource();
      stopCam();
      camEnabled = false;
      camError = null;
      return { ok: true };

    case "WEBRTC_OFFER":
      return handleOffer(msg);

    case "INJECT_ICE":
      return handleIce(msg);

    default:
      return { ok: false, error: `Unknown offscreen message: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  handleOffscreenMessage(msg)
    .then((response) => sendResponse(response === undefined ? { ok: true } : response))
    .catch((err) => {
      console.error("[VTC:offscreen] Handler error:", msg.type, err);
      sendResponse({ error: err.message });
    });
  return true;
});
