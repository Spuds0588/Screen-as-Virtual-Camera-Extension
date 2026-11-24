#!/usr/bin/env bash
# Downloads Chrome for Testing (stable, linux64) into .chrome/ and prints the binary path.
# Branded Google Chrome (137+) silently ignores --load-extension, so automated testing needs CfT.
# Set CHROME to an existing CfT/Chromium binary to skip the download.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.chrome"
VERSION_FILE="$DEST/version.txt"

if [ -n "${CHROME:-}" ] && [ -x "${CHROME}" ]; then
  echo "$CHROME"
  exit 0
fi

if [ -x "$DEST/chrome-linux64/chrome" ] && [ -s "$VERSION_FILE" ]; then
  echo "$DEST/chrome-linux64/chrome"
  exit 0
fi

echo "[test] fetching Chrome for Testing..." >&2
mkdir -p "$DEST"

VERSION="$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json |
  bun -e 'const d = await Bun.stdin.json(); console.log(d.channels.Stable.version);')"

curl -fsSL -o "$DEST/chrome.zip" \
  "https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/linux64/chrome-linux64.zip"
rm -rf "$DEST/chrome-linux64"
( cd "$DEST" && unzip -q -o chrome.zip && rm -f chrome.zip )
chmod +x "$DEST/chrome-linux64/chrome"
echo "$VERSION" >"$VERSION_FILE"
echo "[test] Chrome for Testing $VERSION installed" >&2
echo "$DEST/chrome-linux64/chrome"
