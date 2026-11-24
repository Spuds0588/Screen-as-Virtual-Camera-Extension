// [VTC:popup] Controls. Never owns state: everything asks the offscreen document through background.js.

const params = new URLSearchParams(location.search);
const MODE = params.get("mode");

const $ = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage({ target: "background", ...message });
}

function showError(text) {
  const el = $("errorText");
  if (!el) {
    // Never let an error path itself throw: grant/pick modes replace #app's contents.
    if (text) console.warn("[VTC:popup] (no error slot)", text);
    return;
  }
  el.textContent = text || "";
  el.hidden = !text;
}

async function cameraPermissionGranted() {
  const stored = await chrome.storage.local.get("camGranted").catch(() => ({}));
  if (stored && stored.camGranted === true) return true;
  try {
    const status = await navigator.permissions.query({ name: "camera" });
    return status.state === "granted";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ grant mode (extension tab) */

async function runGrantMode() {
  $("app").innerHTML = '<p class="grantMsg">Asking for camera access…</p>';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((track) => track.stop());
    await chrome.storage.local.set({ camGranted: true });
    await send({ type: "SET_CAM", camEnabled: true }).catch(() => {});
    console.log("[VTC:popup] Camera permission granted");
    $("app").innerHTML = '<p class="grantMsg">Camera ready. You can close this tab.</p>';
    setTimeout(() => window.close(), 800);
  } catch (err) {
    console.error("[VTC:popup] Camera permission failed:", err);
    $("app").innerHTML = `<p class="grantMsg">Camera access failed: ${err.message}.<br />Allow the camera, then close this tab.</p>`;
  }
}

/* ------------------------------------------------------------ desktop picker mode (extension tab) */

function runDesktopPickMode() {
  const camEnabled = params.get("cam") === "1";
  $("app").innerHTML =
    '<p class="grantMsg">Choose a screen, window or tab to share…</p>' +
    '<button id="retryPick" class="primary">Choose source</button>';
  $("retryPick").addEventListener("click", () => pickDesktop(camEnabled));
  pickDesktop(camEnabled);
}

function pickDesktop(camEnabled) {
  showError("");
  chrome.tabs.getCurrent((tab) => {
    const sources = ["screen", "window", "tab"];
    const onStream = async (streamId) => {
      if (!streamId) {
        console.log("[VTC:popup] Desktop pick cancelled");
        window.close();
        return;
      }
      try {
        await send({ type: "START_CAPTURE", sourceType: "desktop", streamId, camEnabled });
        window.close();
      } catch (err) {
        showError(`Could not start sharing: ${err.message}`);
        console.error("[VTC:popup] Desktop capture start failed:", err);
      }
    };

    try {
      chrome.desktopCapture.chooseDesktopMedia(sources, tab, (streamId) => {
        const err = chrome.runtime.lastError?.message;
        if (err) {
          console.warn("[VTC:popup] chooseDesktopMedia error:", err);
          showError(`Chrome refused the source picker: ${err}. Click "Choose source" to retry.`);
          return;
        }
        onStream(streamId);
      });
    } catch (err) {
      showError(`Could not open the picker: ${err.message}. Click "Choose source" to retry.`);
    }
  });
}

/* ------------------------------------------------------------ main popup */

async function initPopup() {
  const dot = $("dot");
  const statusText = $("statusText");
  const camToggle = $("camToggle");
  const camHint = $("camHint");
  const tabBtn = $("tabBtn");
  const screenBtn = $("screenBtn");
  const stopBtn = $("stopBtn");
  const enableBtn = $("enableBtn");

  let granted = false;

  async function refresh() {
    let status = null;
    [status, granted] = await Promise.all([
      send({ type: "GET_STATUS" }).catch((err) => ({ error: err.message })),
      cameraPermissionGranted()
    ]);

    if (status?.error) showError(status.error);

    const active = !!status?.active;
    dot.classList.toggle("live", active);
    statusText.textContent = active
      ? `Live — ${status.sourceType === "desktop" ? "screen / window" : "tab"}`
      : "Idle";
    tabBtn.textContent = active ? "Swap to This Tab" : "Share This Tab";
    screenBtn.textContent = active ? "Swap Screen / Window" : "Share Screen / Window";
    stopBtn.disabled = !active;
    camToggle.checked = active ? !!status.camEnabled : granted;
    camHint.hidden = granted;
    if (active && status.camError) showError(`Webcam overlay unavailable (${status.camError})`);
  }

  camToggle.addEventListener("change", async () => {
    showError("");
    if (camToggle.checked && !(await cameraPermissionGranted())) {
      camToggle.checked = false;
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=grant") });
      return;
    }
    await chrome.storage.local.set({ camEnabledOverlay: camToggle.checked }).catch(() => {});
    const result = await send({ type: "SET_CAM", camEnabled: camToggle.checked }).catch((err) => ({
      error: err.message
    }));
    if (result?.camError) showError(`Webcam overlay unavailable (${result.camError})`);
    refresh();
  });

  tabBtn.addEventListener("click", async () => {
    showError("");
    tabBtn.disabled = true;
    try {
      // Called synchronously in the click handler (and without targetTabId) so the action click's
      // user gesture and activeTab grant are still valid; an await before this call loses them.
      const streamIdPromise = chrome.tabCapture.getMediaStreamId();
      const streamId = await streamIdPromise;
      const result = await send({
        type: "START_CAPTURE",
        sourceType: "tab",
        streamId,
        camEnabled: camToggle.checked
      });
      if (result?.error) throw new Error(result.error);
    } catch (err) {
      console.error("[VTC:popup] Tab capture failed:", err);
      showError(`Tab capture failed: ${err.message}`);
    } finally {
      tabBtn.disabled = false;
      refresh();
    }
  });

  screenBtn.addEventListener("click", async () => {
    showError("");
    await send({ type: "START_DESKTOP_CAPTURE", camEnabled: camToggle.checked }).catch((err) =>
      showError(err.message)
    );
    window.close();
  });

  stopBtn.addEventListener("click", async () => {
    showError("");
    await send({ type: "STOP_CAPTURE" }).catch((err) => showError(err.message));
    refresh();
  });

  enableBtn.addEventListener("click", async () => {
    showError("");
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await send({ type: "ENABLE_ON_TAB", tabId: activeTab?.id });
      if (result?.error) throw new Error(result.error);
      enableBtn.textContent = "Enabled — reload the page if the camera is missing";
    } catch (err) {
      showError(`Could not enable on this page: ${err.message}`);
    }
  });

  await refresh();
}

if (MODE === "grant") runGrantMode();
else if (MODE === "pick") runDesktopPickMode();
else initPopup();
