#!/bin/bash
# Installs (or updates) the T3 sidebar keeper and the restart-reminder helper:
#   ~/.local/share/t3-sidebar-keeper/keeper.mjs, reminders.mjs, proc-birth, vendor/acorn
#   ~/.local/share/t3-sidebar-keeper/T3 Restart Reminders.app
#   ~/Library/LaunchAgents/com.cornishandy.t3-sidebar-keeper.plist
# The job runs Homebrew's node directly, so node needs App Management
# (System Settings > Privacy & Security > App Management). A Homebrew node
# update can switch that off; the keeper then posts a notification.
# Reminder state (snooze, interval, pending) is not part of this install and
# is never rolled back with the code.
# Usage: install.sh            install or update
#        install.sh --uninstall
#        install.sh --rollback CODE_BACKUP (code only; keeps live user state)
#
# Tests set T3_KEEPER_INSTALL_ROOT so nothing here touches the real home or
# the real launchd. T3_KEEPER_INSTALL_FAIL_AT injects a failure at
# stage, validate, quiesce, replace, or bootstrap. T3_REMINDERS_SKIP_BUILD=1
# uses T3_REMINDERS_PREBUILT_APP instead of compiling.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.cornishandy.t3-sidebar-keeper"
NODE="/opt/homebrew/bin/node"
DOMAIN="gui/$(id -u)"
FAIL_AT="${T3_KEEPER_INSTALL_FAIL_AT:-}"
REAL_HOME="$HOME"

if [[ -n "${T3_KEEPER_INSTALL_ROOT:-}" ]]; then
  ROOT="$T3_KEEPER_INSTALL_ROOT"
  HOME_DIR="$ROOT/.local/share/t3-sidebar-keeper"
  LAUNCH_DIR="$ROOT/Library/LaunchAgents"
  LAUNCHCTL_LOG="$ROOT/launchctl.log"
  launchctl() { printf '%s\n' "$*" >> "$LAUNCHCTL_LOG"; return 0; }
else
  HOME_DIR="$HOME/.local/share/t3-sidebar-keeper"
  LAUNCH_DIR="$HOME/Library/LaunchAgents"
fi
PLIST="$LAUNCH_DIR/$LABEL.plist"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Uninstalled the job. Kept $HOME_DIR (backups, log); T3 stays patched until its next update."
  exit 0
fi

for v in "$REAL_HOME" "$NODE" "${T3_KEEPER_INSTALL_ROOT:-}"; do
  if [[ -n "$v" && "$v" == *[\&\<\>\"\']* ]]; then echo "path needs XML escaping, refusing: $v" >&2; exit 1; fi
done
if [[ ! -x "$NODE" ]] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "need Node 20+ at $NODE" >&2; exit 1
fi

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
# Only the installed helper may stay registered with macOS: other copies share
# its bundle id, and a reminder click can open one of them (20 Oct 2026).
register_installed_app() {
  if [[ -z "${T3_KEEPER_INSTALL_ROOT:-}" && -d "$HOME_DIR/T3 Restart Reminders.app" ]]; then
    "$LSREGISTER" -f "$HOME_DIR/T3 Restart Reminders.app" >/dev/null 2>&1 || true
  fi
}
STAGE="$(mktemp -d "${T3_KEEPER_STAGE_PARENT:-/tmp}/t3-keeper-stage.XXXXXX")"
trap '"$LSREGISTER" -u "$STAGE/T3 Restart Reminders.app" >/dev/null 2>&1 || true; rm -rf "$STAGE"' EXIT

CODE_ITEMS=("keeper.mjs" "reminders.mjs" "proc-birth" "vendor" "T3 Restart Reminders.app")

die() { echo "$1" >&2; exit 1; }

write_plist() {
  local dest="$1"
  cat > "$dest" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE</string>
		<string>$HOME_DIR/keeper.mjs</string>
		<string>--auto</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>NODE_OPTIONS</key>
		<string></string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>30</integer>
	<key>WatchPaths</key>
	<array>
		<string>$REAL_HOME/.t3/userdata/server-runtime.json</string>
	</array>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>Nice</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>$HOME_DIR/keeper.log</string>
	<key>StandardErrorPath</key>
	<string>$HOME_DIR/keeper.log</string>
</dict>
</plist>
PLIST
}

stage_tree() {
  mkdir -p "$STAGE/vendor/acorn"
  install -m 700 "$SRC/keeper.mjs" "$STAGE/keeper.mjs"
  install -m 700 "$SRC/reminders.mjs" "$STAGE/reminders.mjs"
  install -m 600 "$SRC/vendor/acorn/acorn.mjs" "$SRC/vendor/acorn/LICENSE" "$SRC/vendor/acorn/VERSION.txt" "$STAGE/vendor/acorn/"
  if [[ "${T3_REMINDERS_SKIP_BUILD:-}" == "1" ]]; then
    [[ -n "${T3_REMINDERS_PREBUILT_APP:-}" && -d "${T3_REMINDERS_PREBUILT_APP}" ]] || die "T3_REMINDERS_PREBUILT_APP must be an app bundle"
    rm -rf "$STAGE/T3 Restart Reminders.app"
    cp -R "$T3_REMINDERS_PREBUILT_APP" "$STAGE/T3 Restart Reminders.app"
    if [[ -n "${T3_REMINDERS_PREBUILT_PROC:-}" ]]; then
      install -m 755 "$T3_REMINDERS_PREBUILT_PROC" "$STAGE/proc-birth"
    else
      printf '#!/bin/sh\nprintf "%%s\\t0\\t0\\t\\n" "$1"\n' > "$STAGE/proc-birth"
      chmod 755 "$STAGE/proc-birth"
    fi
  else
    bash "$SRC/reminders-helper/build.sh" "$STAGE"
  fi
  chmod 700 "$STAGE/keeper.mjs" "$STAGE/reminders.mjs"
  write_plist "$STAGE/agent.plist"
}

validate_tree() {
  "$NODE" --check "$STAGE/keeper.mjs"
  "$NODE" --check "$STAGE/reminders.mjs"
  [[ -x "$STAGE/proc-birth" ]] || die "proc-birth is not executable"
  [[ -x "$STAGE/T3 Restart Reminders.app/Contents/MacOS/T3 Restart Reminders" ]] || die "reminder helper is not executable"
  local bid
  bid="$(plutil -extract CFBundleIdentifier raw "$STAGE/T3 Restart Reminders.app/Contents/Info.plist")"
  [[ "$bid" == "com.cornishandy.t3-restart-reminders" ]] || die "unexpected bundle id: $bid"
  local token expected
  token="$(cat "$STAGE/T3 Restart Reminders.app/Contents/Resources/native-generation")"
  expected="$(cat "$SRC/reminders-helper/main.swift" "$SRC/reminders.mjs" | shasum -a 256 | cut -d ' ' -f 1)"
  [[ "$token" == "$expected" ]] || die "native helper and reminder module are different code generations"
  plutil -lint "$STAGE/agent.plist" >/dev/null
}

if [[ "${1:-}" == "--rollback" ]]; then
  BACKUP="${2:-}"
  "$NODE" -e 'const fs=require("fs"),p=require("path");const [h,b]=process.argv.slice(1);if(!b||p.dirname(p.resolve(b))!==p.join(p.resolve(h),"install-rollback")||!fs.statSync(b).isDirectory())process.exit(1)' "$HOME_DIR" "$BACKUP" || die "rollback must name a retained code backup inside $HOME_DIR/install-rollback"
  for item in "${CODE_ITEMS[@]}"; do
    if [[ -e "$BACKUP/$item" ]]; then cp -R "$BACKUP/$item" "$STAGE/$item"; fi
  done
  if [[ -f "$BACKUP/old.plist" ]]; then cp "$BACKUP/old.plist" "$STAGE/agent.plist"; plutil -lint "$STAGE/agent.plist" >/dev/null; fi
  if [[ -f "$STAGE/keeper.mjs" ]]; then "$NODE" --check "$STAGE/keeper.mjs"; fi
  if [[ -f "$STAGE/reminders.mjs" ]]; then "$NODE" --check "$STAGE/reminders.mjs"; fi
  "$NODE" "$SRC/install-transaction.mjs" "$HOME_DIR" "$STAGE" "$PLIST" "$DOMAIN" rollback
  register_installed_app
  echo "Restored retained code; live reminder settings and snooze were kept."
  exit 0
fi

stage_tree
if [[ "$FAIL_AT" == "stage" ]]; then die "injected failure at stage"; fi
validate_tree
if [[ "$FAIL_AT" == "validate" ]]; then die "injected failure at validate"; fi

"$NODE" "$SRC/install-transaction.mjs" "$HOME_DIR" "$STAGE" "$PLIST" "$DOMAIN"
register_installed_app
echo "Loaded $LABEL (checks every 30 s and whenever T3's server starts)."
