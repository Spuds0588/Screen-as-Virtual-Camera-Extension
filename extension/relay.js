// [VTC:relay] ISOLATED world bridge between the page's MAIN-world shim and the extension.
(() => {
  "use strict";

  if (window.__vtcRelayInstalled) return;
  window.__vtcRelayInstalled = true;

  const FROM_INJECT = "vtc-inject";
  const FROM_EXTENSION = "vtc-relay";

  console.log("[VTC:relay] Bridge installed on", location.origin);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== FROM_INJECT || !data.payload) return;

    if (data.payload.type === "VTC_HELLO") {
      window.postMessage({ source: FROM_EXTENSION, payload: { type: "VTC_RELAY_READY" } }, "*");
      return;
    }

    try {
      chrome.runtime
        .sendMessage({
          target: "background",
          type: "RELAY_TO_OFFSCREEN",
          payload: data.payload
        })
        .catch((err) => console.warn("[VTC:relay] Message rejected:", err.message));
    } catch (err) {
      console.warn("[VTC:relay] Extension context invalidated — reload this page.", err.message);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.source !== FROM_EXTENSION) return;
    window.postMessage(msg, "*");
  });
})();
