#!/bin/bash
# Build the restart-reminder helper into a staging directory.
# Does not install it, request notification permission, or talk to launchd.
# Usage: build.sh [output-directory]
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SRC/.." && pwd)"
OUT="${1:-$HOME/Library/Caches/t3-restart-reminders/staging}"
SDK="$(xcrun --show-sdk-path)"
APP="$OUT/T3 Restart Reminders.app"
MACOS="$APP/Contents/MacOS"
EXE="$MACOS/T3 Restart Reminders"

mkdir -p "$MACOS" "$OUT"
mkdir -p "$APP/Contents/Resources"
TOKEN="$(cat "$SRC/main.swift" "$ROOT/reminders.mjs" | shasum -a 256 | cut -d ' ' -f 1)"
printf 'let nativeBuildToken = "%s"\n' "$TOKEN" > "$OUT/native-generation.swift"
printf '%s\n' "$TOKEN" > "$APP/Contents/Resources/native-generation"
clang -O2 -target arm64-apple-macos12.0 -isysroot "$SDK" \
  -o "$OUT/proc-birth" "$SRC/proc-birth.c"
swiftc -parse-as-library -target arm64-apple-macos12.0 -sdk "$SDK" \
  -module-cache-path "$OUT/swift-module-cache" \
  -framework AppKit -framework UserNotifications \
  -o "$EXE" "$SRC/main.swift" "$OUT/native-generation.swift"
cp "$SRC/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/reminders.mjs" "$OUT/reminders.mjs"
chmod 755 "$EXE" "$OUT/proc-birth"
chmod 644 "$OUT/reminders.mjs" "$APP/Contents/Info.plist"
codesign --sign - --force "$OUT/proc-birth"
codesign --sign - --force --deep "$APP"
codesign --verify --strict "$APP"
# A built copy is never the installed one. It shares the real bundle id, so if
# macOS keeps it registered a reminder click can open it instead (20 Oct 2026).
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
