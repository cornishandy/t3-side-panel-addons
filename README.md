# T3 side-panel add-ons

> **Personal experiment.** I'm not a professional developer; I use T3 Code on my Mac for personal movie and Twitter projects. I made this to suit my own workflow. It isn't an official T3 Code project or a supported product.

Personal customizations for the sidebar (side panel) of **T3 Code (Nightly)** on macOS. Two parts, kept together because each needs the other:

- **[`t3-extras/`](t3-extras/README.md)** — the add-ons themselves, behind a **✦** button in the sidebar's bottom row: usage meters for each AI lab (Claude, Codex, Gemini, Grok), thread "burn" tells, a Prepare handover button and handover chain pill, compact thread rows and other sidebar polish, an 18-area Fonts workspace, and the reply-footer card styling. Each add-on has its own switch. A small Node server on `127.0.0.1:8793` (loopback only, every request must come from T3's own `t3code://app` origin) serves them.
- **[`t3-sidebar-keeper/`](t3-sidebar-keeper/README.md)** — a LaunchAgent that re-applies small patches to T3's `app.asar` after every nightly update: wrapping sidebar titles, a 140 px minimum sidebar width, shorter generated titles, the tiny loader that pulls in the add-ons, first-click click-through, and a Gemini quota fix.

These are built for one person's Mac and T3 Nightly builds. They patch an Electron app in place, so read both READMEs before installing; nothing here is supported by the T3 Code project.

## Install

These add-ons are for a Mac where every account is trusted. On a shared Mac, do not install them. Read [SECURITY.md](SECURITY.md) first. The ✦ switches do not hide what the service answers.

You need macOS on Apple silicon, T3 Code (Nightly) at `/Applications/T3 Code (Nightly).app` (opened once, so Gatekeeper has accepted that build), Node.js 22.16 or newer on the 22 line, or Node.js 24 or newer, and Xcode Command Line Tools (`xcode-select --install`). The reminder helper is built for arm64 and is compiled on every install. Grant App Management to the exact Node binary the keeper installer prints (System Settings > Privacy & Security > App Management). The installers use that path as they find it. They do not resolve a symlink. Discovery order is `T3X_NODE`, then `node` on `PATH`, then `/opt/homebrew/bin/node`, then `/usr/local/bin/node`. A version-manager path gets a warning, not a refusal.

Install the add-ons service first, then the keeper, from this repository:

```sh
t3-extras/install.sh
t3-sidebar-keeper/install.sh
```

Press Shift-Cmd-R in T3 after the keeper has patched the running build.

What changes on disk: `app.asar` inside T3 Code (Nightly), in place; two LaunchAgents, `com.cornishandy.t3-extras` and `com.cornishandy.t3-sidebar-keeper`; `~/.local/share/t3-extras` and `~/.local/share/t3-sidebar-keeper`.

A fresh keeper install (no installed `keeper.mjs` and no `disabled.json`) turns off `rule`, `fit` and `titleGuide`, and turns off app-restart reminders. An install that already has either file is left as it is. Turn one back on with `node ~/.local/share/t3-sidebar-keeper/keeper.mjs --enable rule` (also `fit`, `titleGuide` or `extras`).

What it reads, on this Mac: T3's saved quota readings, T3's state database and environment id, usage rates, settings and the usage scan cache, and transcript files under `~/.claude/projects`, `~/.codex/sessions`, `~/.codex-t3-api/sessions` and `~/.grok/sessions`. When `~/.claude/bin/lab-usage` or `~/.claude/bin/handover` is executable, the service uses it. A missing tool stays off. The list is in [SECURITY.md](SECURITY.md).

Network: one-time pinned font downloads over https, each checked against its sha256, from `fonts.gstatic.com` and `raw.githubusercontent.com`. Nothing else, and no telemetry. Those optional tools, if you have them, are separate programs.

To remove everything, restore T3 before you delete the keeper:

```sh
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --restore
t3-extras/install.sh --uninstall
t3-sidebar-keeper/install.sh --uninstall
```

Quit and reopen T3 after `--restore`. The keeper's uninstall only removes its background job: `~/.local/share/t3-sidebar-keeper` (its log, settings and the original-file backups) stays, so delete that folder yourself if you want it gone. Uninstall does not clear T3's localStorage keys `t3x:settings:v1`, `t3x:diag` and `t3x:reported-version`, or the IndexedDB database `t3x-usage-history`. Those are the add-ons' own keys, not T3's. Delete them yourself if you want them gone.

## Known issues

- Keeper `minWidth` fails on T3 0.1.3 (the sidebar width clamp changed shape). Seven keeper tests fail because of it. The other units still apply.
- `geminiQuota` works around pingdotgg/t3code#22876. Remove that unit once T3 fixes it.
- Apple silicon only.

## Tests

```sh
(cd t3-extras && node --test test/*.test.mjs)
(cd t3-sidebar-keeper && node --test test/*.test.mjs)
```

## Status

- [x] Usage meters, burn tells, handover button and chain pill
- [x] Compact threads, sidebar polish, Fonts workspace with T3's own fonts
- [x] Sidebar sections: a "Pinned" label and line, older threads folded under "Show N older", one-row titles that keep a trailing (N) — each with its own switch
- [x] Keeper units: wrap, minWidth, rule, fit, titleGuide, extras, firstClick, geminiQuota
- [ ] Keeper `minWidth` unit fails on T3 0.1.3 builds (sidebar width clamp changed shape); 7 keeper tests fail because of it
- [x] Compact sidebar usage in a short window (under 800 px tall)
- [x] Find fonts on screen: hover names the font area, Shift labels every area, a click opens Fonts beside the text, Show on screen — each with its own switch
- [x] All 220 add-on tests pass (browser tests use the newest installed headless Chrome)
- [ ] Delete `geminiQuota` once T3 fixes pingdotgg/t3code#22876

## Docs

- [SECURITY.md](SECURITY.md) — what this protects, and what it does not
- [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they are
- [docs/SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md) — history and a resume prompt

MIT licensed. Vendored [acorn](t3-sidebar-keeper/vendor/acorn/) keeps its own MIT license.
