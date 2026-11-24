// [VTC:bg] Service worker: owns the offscreen compositor, routes signaling, owns the "is it live" state.

const OFFSCREEN_URL = "offscreen.html";
const BADGE_LIVE_COLOR = "#16a34a";

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    console.log("[VTC:bg] Creating offscreen document");
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA", "WEB_RTC"],
        justification:
          "Composite the captured tab, window or screen with the webcam and serve it to meeting pages over a local WebRTC loopback"
      })
      .catch((err) => {
        // A concurrent creation is fine: the document exists now.
        const message = String(err?.message || err);
        if (!/single offscreen|already/i.test(message)) throw err;
        console.warn("[VTC:bg] Offscreen already being created:", message);
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// Keep the compositor alive from the moment the extension loads: creating it lazily raced with a
// freshly granted tab-capture stream id and made the first redemption fail.
ensureOffscreen().catch((err) => console.error("[VTC:bg] Could not start the offscreen compositor:", err));

async function sendToOffscreen(message) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
  if (response && response.error) throw new Error(response.error);
  return response;
}

async function setBadge(live) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_LIVE_COLOR });
    await chrome.action.setBadgeText({ text: live ? "LIVE" : "" });
  } catch (err) {
    console.warn("[VTC:bg] Badge update failed:", err.message);
  }
}

async function startCapture({ sourceType, streamId, camEnabled }) {
  if (!streamId) throw new Error("No capture stream id was provided");
  const response = await sendToOffscreen({
    type: "START_CAPTURE",
    sourceType: sourceType === "desktop" ? "desktop" : "tab",
    streamId,
    camEnabled: !!camEnabled
  });
  await setBadge(true);
  return response || { ok: true };
}

async function stopCapture() {
  if (await hasOffscreen()) {
    await sendToOffscreen({ type: "STOP_CAPTURE" }).catch((err) =>
      console.warn("[VTC:bg] Stop capture failed:", err.message)
    );
  }
  await setBadge(false);
  return { ok: true };
}

async function getStatus() {
  const idle = { active: false, sourceType: null, camEnabled: false, camError: null };
  if (!(await hasOffscreen())) return idle;
  const status = await sendToOffscreen({ type: "GET_STATUS" }).catch(() => null);
  return status || idle;
}

function openDesktopPickerTab(camEnabled) {
  const url = chrome.runtime.getURL(`popup.html?mode=pick&cam=${camEnabled ? 1 : 0}`);
  return chrome.tabs.create({ url }).catch((err) => {
    console.error("[VTC:bg] Could not open picker tab:", err.message);
  });
}

// chooseDesktopMedia is callback based. Called from the service worker it may or may not get the
// user gesture that survived the popup click, so the failure path opens an extension tab that owns
// the picker (and its own button) instead of leaving the user with nothing.
function launchDesktopPicker(camEnabled) {
  let settled = false;

  const fallback = (reason) => {
    if (settled) return;
    settled = true;
    console.warn("[VTC:bg] Desktop picker needs a tab context:", reason);
    openDesktopPickerTab(camEnabled);
  };

  try {
    chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab"], (streamId) => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        fallback(err);
        return;
      }
      if (settled) return;
      settled = true;
      if (!streamId) {
        console.log("[VTC:bg] Desktop capture cancelled by the user");
        return;
      }
      console.log("[VTC:bg] Desktop picker returned a stream id, starting capture");
      startCapture({ sourceType: "desktop", streamId, camEnabled }).catch((e) =>
        console.error("[VTC:bg] Failed to start desktop capture:", e)
      );
    });
  } catch (err) {
    fallback(err.message);
  }
}

async function enableOnActiveTab(tabId) {
  if (tabId == null) throw new Error("No active tab to enable");
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ["relay.js"], world: "ISOLATED" });
  await chrome.scripting.executeScript({ target, files: ["inject.js"], world: "MAIN" });
  return { ok: true };
}

async function handleBackgroundMessage(msg, sender) {
  switch (msg.type) {
    case "GET_STATUS":
      return getStatus();

    case "START_CAPTURE":
      return startCapture(msg);

    case "START_DESKTOP_CAPTURE":
      launchDesktopPicker(!!msg.camEnabled);
      return { ok: true, pending: true };

    case "SET_CAM":
      return sendToOffscreen({ type: "SET_CAM", camEnabled: !!msg.camEnabled });

    case "STOP_CAPTURE":
      return stopCapture();

    case "CAPTURE_ENDED":
      console.log("[VTC:bg] Capture ended, clearing badge");
      await setBadge(false);
      return { ok: true };

    case "ENABLE_ON_TAB":
      return enableOnActiveTab(msg.tabId);

    case "RELAY_TO_OFFSCREEN":
      await ensureOffscreen();
      return chrome.runtime.sendMessage({
        target: "offscreen",
        ...msg.payload,
        tabId: sender.tab?.id,
        frameId: sender.frameId ?? 0
      });

    case "RELAY_TO_TAB":
      if (msg.tabId == null) return { ok: false };
      await chrome.tabs
        .sendMessage(msg.tabId, { source: "vtc-relay", payload: msg.payload }, { frameId: msg.frameId ?? 0 })
        .catch((err) => console.warn("[VTC:bg] Relay to tab failed:", msg.tabId, err.message));
      return { ok: true };

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

/* ------------------------------------------------------------------ keyboard shortcut */

// The tab id has to be known synchronously inside the shortcut gesture, and chrome.tabs.query() is
// async, so keep a warm copy of the active tab.
let activeTabId = null;

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) activeTabId = tab.id;
  return activeTabId;
}

refreshActiveTab().catch(() => {});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
});
chrome.windows?.onFocusChanged?.addListener(() => {
  refreshActiveTab().catch(() => {});
});

async function handleShortcutCapture(pendingStreamId) {
  const status = await getStatus();
  if (status.active) {
    console.log("[VTC:bg] Shortcut: stopping the current share");
    await stopCapture();
    return;
  }
  if (!pendingStreamId) throw new Error("This tab cannot be captured (no extension invocation)");
  const streamId = await pendingStreamId;
  const stored = await chrome.storage.local.get("camEnabledOverlay").catch(() => ({}));
  await startCapture({ sourceType: "tab", streamId, camEnabled: stored?.camEnabledOverlay === true });
  console.log("[VTC:bg] Shortcut: sharing the active tab");
}

// A keyboard command counts as an extension invocation, which is what tabCapture needs. The
// getMediaStreamId call has to happen synchronously inside the gesture, before any await.
chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-share") return;
  let pendingStreamId = null;
  try {
    pendingStreamId = chrome.tabCapture.getMediaStreamId(
      activeTabId != null ? { targetTabId: activeTabId } : undefined
    );
  } catch (err) {
    console.error("[VTC:bg] Shortcut: tabCapture unavailable:", err.message);
  }
  handleShortcutCapture(pendingStreamId).catch((err) =>
    console.error("[VTC:bg] Shortcut failed:", err.message)
  );
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "background") return false;
  handleBackgroundMessage(msg, sender)
    .then((response) => sendResponse(response === undefined ? { ok: true } : response))
    .catch((err) => {
      console.error("[VTC:bg] Message error:", msg.type, err);
      sendResponse({ error: err.message });
    });
  return true;
});
