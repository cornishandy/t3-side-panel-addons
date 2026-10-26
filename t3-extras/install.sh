#!/bin/bash
# Installs (or updates) the T3 add-ons service:
#   ~/.local/share/t3-extras/ (server.mjs, lib.mjs, history.mjs, burn*.mjs, grouping*.mjs, fonts.json, public/, fonts/)
#   (the service keeps its usage history there too: usage-history.jsonl, bounded)
#   ~/Library/LaunchAgents/com.cornishandy.t3-extras.plist  (always on, 127.0.0.1:8793 only)
# Fonts (46 Google families + their licences) are downloaded once from the pinned URLs in
# fonts.json and must match their sha256. The installer also creates an ECDSA P-256 key
# (signing-key.pem, loader-key.json) and signs public/extras.sig. The private key stays here.
# The loader inside T3 comes from the sidebar keeper (unit "extras"); install this first.
# Usage: install.sh            install or update
#        install.sh --uninstall
#
# Tests set T3X_EXTRAS_INSTALL_ROOT so nothing here touches the real home, launchd, or port 8793.
# T3X_FONTS_DIR, when set, is a local directory of the pinned font files (no network).
# T3X_NODE, when set, is the node binary to use (absolute path, not resolved).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.cornishandy.t3-extras"
DOMAIN="gui/$(id -u)"
PORT=8793

if [[ -n "${T3X_EXTRAS_INSTALL_ROOT:-}" ]]; then
  ROOT="$T3X_EXTRAS_INSTALL_ROOT"
  HOME_DIR="$ROOT/.local/share/t3-extras"
  LAUNCH_DIR="$ROOT/Library/LaunchAgents"
  TESTING=1
else
  ROOT=""
  HOME_DIR="$HOME/.local/share/t3-extras"
  LAUNCH_DIR="$HOME/Library/LaunchAgents"
  TESTING=0
fi
PLIST="$LAUNCH_DIR/$LABEL.plist"

discover_node() {
  local c
  if [[ -n "${T3X_NODE:-}" ]]; then
    printf '%s\n' "$T3X_NODE"
    return
  fi
  c="$(command -v node 2>/dev/null || true)"
  if [[ -n "$c" && "$c" == /* ]]; then
    printf '%s\n' "$c"
    return
  fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$c" ]]; then
      printf '%s\n' "$c"
      return
    fi
  done
  return 1
}

warn_version_manager() {
  case "$1" in
    */.nvm/*|*/.volta/*|*/.asdf/*|*/.fnm/*|*/fnm/node-versions/*)
      echo "warning: node is managed by a version manager and can move; App Management is tied to this exact path: $1" >&2
      ;;
  esac
}

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ "$TESTING" == "0" ]]; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  fi
  rm -f "$PLIST"
  rm -rf "$HOME_DIR"
  echo "Removed the add-ons service and $HOME_DIR. T3 now shows nothing extra after Shift-Cmd-R."
  echo "To also take the loader out of T3: node ~/.local/share/t3-sidebar-keeper/keeper.mjs --disable extras"
  exit 0
fi

if ! NODE="$(discover_node)"; then
  echo "need Node 22.16+ or 24+ (set T3X_NODE, or install node on PATH, or use Homebrew)" >&2
  exit 1
fi

for v in "$HOME" "$NODE" "${T3X_EXTRAS_INSTALL_ROOT:-}" "${T3X_FONTS_DIR:-}"; do
  if [[ -n "$v" && "$v" == *[\&\<\>\"\']* ]]; then echo "path needs XML escaping, refusing: $v" >&2; exit 1; fi
done
if [[ "$NODE" != /* || ! -x "$NODE" ]]; then
  echo "node must be an absolute executable path: $NODE" >&2
  exit 1
fi
if ! "$NODE" "$SRC/node-probe.mjs"; then
  echo "need Node 22.16+ or 24+ that can open sqlite, at $NODE" >&2
  exit 1
fi
warn_version_manager "$NODE"
if ! xcrun --find swiftc >/dev/null 2>&1 || ! xcrun --find clang >/dev/null 2>&1; then
  echo "need Xcode Command Line Tools (swiftc and clang). Install them with: xcode-select --install" >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Apple silicon (arm64) only" >&2
  exit 1
fi

NODE_BIN_DIR="$(dirname "$NODE")"
if [[ "$NODE_BIN_DIR" == "/usr/bin" || "$NODE_BIN_DIR" == "/bin" ]]; then
  NODE_PATH_ENV="/usr/bin:/bin:/usr/sbin:/sbin"
else
  NODE_PATH_ENV="$NODE_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
fi

mkdir -p "$HOME_DIR/public" "$HOME_DIR/fonts" "$LAUNCH_DIR"
chmod 700 "$HOME_DIR"

# Fonts: copy or fetch each pinned file once, check its sha256, then install it.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/t3x-fonts.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
if [[ "$TESTING" == "1" && -z "${T3X_FONTS_DIR:-}" ]]; then
  echo "test install: skipping font download (set T3X_FONTS_DIR to supply the pinned files)" >&2
else
"$NODE" -e '
  const m = require(process.argv[1]);
  for (const f of m.files) console.log([f.file, f.url, f.sha256].join("\t"));
' "$SRC/fonts.json" | while IFS=$'\t' read -r file url want; do
  [[ "$file" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad font file name: $file" >&2; exit 1; }
  dest="$HOME_DIR/fonts/$file"
  if [[ -f "$dest" ]] && [[ "$(shasum -a 256 "$dest" | cut -c1-64)" == "$want" ]]; then continue; fi
  if [[ -n "${T3X_FONTS_DIR:-}" ]]; then
    [[ -f "$T3X_FONTS_DIR/$file" ]] || { echo "missing $file in T3X_FONTS_DIR" >&2; exit 1; }
    cp "$T3X_FONTS_DIR/$file" "$TMP/$file"
  else
    curl -fsS --max-time 60 --proto =https -o "$TMP/$file" "$url"
  fi
  got="$(shasum -a 256 "$TMP/$file" | cut -c1-64)"
  if [[ "$got" != "$want" ]]; then echo "sha256 mismatch for $file (got $got); not installed" >&2; exit 1; fi
  install -m 600 "$TMP/$file" "$dest"
done
fi

"$NODE" -e 'for (const f of require(process.argv[1]).files) console.log(f.file)' "$SRC/fonts.json" > "$TMP/keep"
for f in "$HOME_DIR/fonts"/*; do
  [[ -e "$f" ]] || continue
  grep -qxF "$(basename "$f")" "$TMP/keep" || rm -f "$f"
done

install -m 600 "$SRC/server.mjs" "$SRC/lib.mjs" "$SRC/history.mjs" "$SRC/burn.mjs" "$SRC/burn-core.mjs" "$SRC/burn-sql-worker.mjs" "$SRC/grouping.mjs" "$SRC/grouping-core.mjs" "$SRC/grouping-sql-worker.mjs" "$SRC/fonts.json" "$SRC/payload.mjs" "$SRC/private-file.mjs" "$HOME_DIR/"
install -m 600 "$SRC/public/extras.js" "$SRC/public/extras.css" "$HOME_DIR/public/"
# The sidebar view chooser (Group / Sort / Native) is not installed (25 Oct 2026: native list only).
# Its source stays in public/grouping.*; the service serves it only when those files are installed.
rm -f "$HOME_DIR/public/grouping.js" "$HOME_DIR/public/grouping.css"
"$NODE" "$SRC/sign.mjs" "$HOME_DIR"

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
		<string>$NODE_PATH_ENV</string>
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
chmod 700 "$HOME_DIR"
# launchd opens server.log itself, so make it a regular 0600 file (never a symlink) first.
[[ -L "$HOME_DIR/server.log" ]] && rm -f "$HOME_DIR/server.log"
(umask 077; : >> "$HOME_DIR/server.log")
chmod 600 "$HOME_DIR/server.log"

if [[ "$TESTING" == "1" ]]; then
  echo "Installed under the test root (no launchd, no port $PORT). Node: $NODE"
  exit 0
fi

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
    echo "App Management: grant it to this exact node binary (System Settings > Privacy & Security > App Management):"
    echo "  $NODE"
    exit 0
  fi
  sleep 0.5
done
echo "Loaded $LABEL, but it isn't answering yet; see $HOME_DIR/server.log" >&2
exit 1
