#!/usr/bin/env bash
# Builds the dev extension, serves the harness, launches a HEADED Chrome with the extension loaded
# and runs the CDP driver against it. Capture is triggered with a real keyboard shortcut
# (Ctrl+Shift+Y), because tabCapture needs a genuine extension invocation.
# NOTE: never add --use-fake-ui-for-media-stream or --use-fake-device-for-media-stream here:
# Chrome's fake media UI makes tabCapture ids un-redeemable (NotFoundError).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${PROFILE:-/tmp/vtc-chrome-profile}"
PORT="${PORT:-8123}"
if [ "$PORT" = "0" ] || [ -z "$PORT" ]; then PORT=8123; fi
CDP_PORT="${CDP_PORT:-9222}"
LOG_DIR="/tmp/vtc-test-logs"
mkdir -p "$LOG_DIR"

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "[test] No DISPLAY/WAYLAND_DISPLAY: a headed browser cannot be shown on this machine." >&2
  exit 3
fi

CHROME="$(bash "$ROOT/test/fetch-chrome.sh")" || exit 1
echo "[test] chrome: $CHROME $("$CHROME" --version 2>/dev/null || echo missing)"

bun "$ROOT/test/build.mjs" || exit 1

bun "$ROOT/test/serve.mjs" >"$LOG_DIR/serve.log" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  if [ -n "${CHROME_PID:-}" ]; then
    kill "$CHROME_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/test/harness.html" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

# A leftover Chrome holding the CDP port makes the driver attach to the wrong browser and fail in
# confusing ways, so refuse to start instead.
if curl -fsS "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
  echo "[test] something is already listening on CDP port $CDP_PORT (another Chrome?). Close it, or set CDP_PORT." >&2
  exit 4
fi

rm -rf "$PROFILE"

"$CHROME" \
  --user-data-dir="$PROFILE" \
  --load-extension="$ROOT/dist/dev" \
  --disable-extensions-except="$ROOT/dist/dev" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins='*' \
  --no-first-run \
  --no-default-browser-check \
  --disable-search-engine-choice-screen \
  --disable-blink-features=AutomationControlled \
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36" \
  --ozone-platform=x11 \
  --window-size=1400,1000 \
  --window-position=40,40 \
  "http://127.0.0.1:$PORT/test/harness.html?bg=magenta" \
  >"$LOG_DIR/chrome.log" 2>&1 &
CHROME_PID=$!

echo "[test] chrome pid=$CHROME_PID profile=$PROFILE cdp=$CDP_PORT"

CDP_HTTP="http://127.0.0.1:$CDP_PORT" PORT="$PORT" bun "$ROOT/test/driver.mjs"
STATUS=$?

echo "[test] driver exit $STATUS (chrome log: $LOG_DIR/chrome.log)"
exit "$STATUS"
