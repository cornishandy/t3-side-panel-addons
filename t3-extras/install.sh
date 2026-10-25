#!/bin/bash
# Installs (or updates) the T3 add-ons service:
#   ~/.local/share/t3-extras/ (server.mjs, lib.mjs, history.mjs, burn*.mjs, grouping*.mjs, fonts.json, public/, fonts/)
#   (the service keeps its usage history there too: usage-history.jsonl, bounded)
#   ~/Library/LaunchAgents/com.cornishandy.t3-extras.plist  (always on, 127.0.0.1:8793 only)
# Fonts (46 Google families + their licences) are downloaded once from the pinned URLs in
# fonts.json and must match their sha256.
# The loader inside T3 comes from the sidebar keeper (unit "extras"); see README.md.
# Usage: install.sh            install or update
#        install.sh --uninstall
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.cornishandy.t3-extras"
HOME_DIR="$HOME/.local/share/t3-extras"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE="/opt/homebrew/bin/node"
PORT=8793

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$HOME_DIR"
  echo "Removed the add-ons service and $HOME_DIR. T3 now shows nothing extra after Shift-Cmd-R."
  echo "To also take the tiny loader out of T3: node ~/.local/share/t3-sidebar-keeper/keeper.mjs --disable extras"
  exit 0
fi

for v in "$HOME" "$NODE"; do
  if [[ "$v" == *[\&\<\>\"\']* ]]; then echo "path needs XML escaping, refusing: $v" >&2; exit 1; fi
done
if [[ ! -x "$NODE" ]] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "need Node 20+ at $NODE" >&2; exit 1
fi

mkdir -p "$HOME_DIR/public" "$HOME_DIR/fonts" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME_DIR"

# Fonts: fetch each pinned file once into a fresh temp folder, check its sha256, then move it in.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/t3x-fonts.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
"$NODE" -e '
  const m = require(process.argv[1]);
  for (const f of m.files) console.log([f.file, f.url, f.sha256].join("\t"));
' "$SRC/fonts.json" | while IFS=$'\t' read -r file url want; do
  [[ "$file" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad font file name: $file" >&2; exit 1; }
  dest="$HOME_DIR/fonts/$file"
  if [[ -f "$dest" ]] && [[ "$(shasum -a 256 "$dest" | cut -c1-64)" == "$want" ]]; then continue; fi
  curl -fsS --max-time 60 --proto =https -o "$TMP/$file" "$url"
  got="$(shasum -a 256 "$TMP/$file" | cut -c1-64)"
  if [[ "$got" != "$want" ]]; then echo "sha256 mismatch for $file (got $got); not installed" >&2; exit 1; fi
  install -m 600 "$TMP/$file" "$dest"
done

# Drop font files that are no longer on the list (the service only serves listed names anyway).
"$NODE" -e 'for (const f of require(process.argv[1]).files) console.log(f.file)' "$SRC/fonts.json" > "$TMP/keep"
for f in "$HOME_DIR/fonts"/*; do
  [[ -e "$f" ]] || continue
  grep -qxF "$(basename "$f")" "$TMP/keep" || rm -f "$f"
done

install -m 600 "$SRC/server.mjs" "$SRC/lib.mjs" "$SRC/history.mjs" "$SRC/burn.mjs" "$SRC/burn-core.mjs" "$SRC/burn-sql-worker.mjs" "$SRC/grouping.mjs" "$SRC/grouping-core.mjs" "$SRC/grouping-sql-worker.mjs" "$SRC/fonts.json" "$HOME_DIR/"
install -m 600 "$SRC/public/extras.js" "$SRC/public/extras.css" "$HOME_DIR/public/"
# The sidebar view chooser (Group / Sort / Native) is not installed (Andy, 25 Oct 2026: native list only).
# Its source stays in public/grouping.*; the service serves it only when those files are installed.
rm -f "$HOME_DIR/public/grouping.js" "$HOME_DIR/public/grouping.css"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE</string>
		<string>$HOME_DIR/server.mjs</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>NODE_OPTIONS</key>
		<string></string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<!-- No ProcessType Background / Nice: that throttling left node stuck in start-up for minutes. -->
	<key>StandardOutPath</key>
	<string>$HOME_DIR/server.log</string>
	<key>StandardErrorPath</key>
	<string>$HOME_DIR/server.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# The old copy needs a moment to let go of the port.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  /usr/sbin/lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.5
done
if /usr/sbin/lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is in use by something else; not starting" >&2; exit 1
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 -H "Origin: t3code://app" "http://127.0.0.1:$PORT/version" >/dev/null 2>&1; then
    echo "Loaded $LABEL on 127.0.0.1:$PORT (loopback only)."
    exit 0
  fi
  sleep 0.5
done
echo "Loaded $LABEL, but it isn't answering yet; see $HOME_DIR/server.log" >&2
exit 1
