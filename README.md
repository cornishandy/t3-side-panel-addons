# T3 side-panel add-ons

> **Personal experiment.** I'm not a professional developer; I use T3 Code on my Mac for personal movie and Twitter projects. I made this to suit my own workflow. It isn't an official T3 Code project or a supported product.

Personal customizations for the sidebar (side panel) of **T3 Code (Nightly)** on macOS. Two parts, kept together because each needs the other:

- **[`t3-extras/`](t3-extras/README.md)** — the add-ons themselves, behind a **✦** button in the sidebar's bottom row: usage meters for each AI lab (Claude, Codex, Gemini, Grok), thread "burn" tells, a Prepare handover button and handover chain pill, compact thread rows and other sidebar polish, an 18-area Fonts workspace, and the reply-footer card styling. Each add-on has its own switch. A small Node server on `127.0.0.1:8793` (loopback only, every request must come from T3's own `t3code://app` origin) serves them.
- **[`t3-sidebar-keeper/`](t3-sidebar-keeper/README.md)** — a LaunchAgent that re-applies small patches to T3's `app.asar` after every nightly update: wrapping sidebar titles, a 140 px minimum sidebar width, shorter generated titles, the tiny loader that pulls in the add-ons (and, from Nightly 5138, the one exception to T3's header stripping that lets it reach them), first-click click-through, and a Gemini quota fix.

These are built for one person's Mac and T3 Nightly builds. They patch an Electron app in place, so read both READMEs before installing; nothing here is supported by the T3 Code project.

## Install

These add-ons are for a Mac where every account is trusted. On a shared Mac, do not install them. Read [SECURITY.md](SECURITY.md) first. The ✦ switches do not hide what the service answers.

You need macOS on Apple silicon, T3 Code (Nightly) at `/Applications/T3 Code (Nightly).app` (opened once, so Gatekeeper has accepted that build), Node.js 22.16 or newer on the 22 line, or Node.js 24 or newer, and Xcode Command Line Tools (`xcode-select --install`). The reminder helper is built for arm64 and is compiled on every install. Grant App Management to the exact Node binary the keeper installer prints (System Settings > Privacy & Security > App Management). The installers use that path as they find it. They do not resolve a symlink. Discovery order is `T3X_NODE`, then `node` on `PATH`, then `/opt/homebrew/bin/node`, then `/usr/local/bin/node`. When it updates an existing install, the keeper's installer puts the binary recorded in that install's `node-path` ahead of `PATH`, so the job stays on the binary that already has App Management; set `T3X_NODE` to change it. A version-manager path gets a warning, not a refusal.

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

- Nightly `0.1.12-nightly.20261123.5138` started stripping the `Origin` header from every request T3's window makes, so the add-ons service refused the loader and no add-on appeared (23 Nov 2026). Keeper v21's `extrasOrigin` unit keeps the header for plain `http://127.0.0.1:8793` only, and only while the add-ons loader is installed. It lives in T3's desktop start-up code, so after each nightly update the add-ons appear once T3 has been quit and reopened after the keeper patched it; Shift-Cmd-R alone isn't enough on those builds.
- Older keeper builds failed to patch `minWidth` on T3 0.1.3 and Nightly `0.1.11-nightly.20261117.4838`–`0.1.12-nightly.20261121.5051` after the sidebar width clamp changed shape (`}` instead of `,` on the third clamp). Keeper v19 supports all three clamp shapes; committed tests cover them. A failed width patch leaves that build’s original width unchanged; update the keeper for supported builds.
- Nightly `0.1.12-nightly.20261121.5024`–`5051` split T3's server bundles three ways, moving `sanitizeThreadTitle` and the title-length rule into the small (~35 KB) `ProviderEventLoggers-*.mjs` chunk while keeping `subagentThreadTitle`, `T3_CODE_ORCHESTRATION_SECTIONS`, and the Antigravity quota probe in `runtimeLayer-*.mjs` and `threadTitle` in `server-*.mjs`. Keeper v19 discovers each server marker independently across `apps/server/dist/*.mjs`, patches all three `fit` chunks atomically, and uses a compact `t3KeeperFitTitle` helper plus Acorn-verified whitespace reclaim for small comment-poor chunks.
- `geminiQuota` retains the workaround for pingdotgg/t3code#22876 on older builds. Nightly `0.1.8-nightly.20261106.4247` already sends `2.24.0`, so this unit reports `already` without rewriting it. Nightly `0.1.10-nightly.20261113.4643` moved the probe to another server bundle, which keeper v14 could not find (`cannot patch: Antigravity probe User-Agent found 0 times`; harmless, since that build needs no patch); keeper v15 finds it in either bundle.
- Nightly `0.1.10-nightly.20261115.4736` removed the sidebar title span's `aria-hidden` and `data-testid="thread-title-*"`, and puts the model icons in the title row when a thread has no branch or PR line. The Thread titles font, picking it on screen, the selected-title bold, tighter rows, compact and one-row titles, the inline model icon, the burn-chip anchor and the keeper's title wrapping all stopped applying; they match the new markup since 15 Nov (keeper v16), and the old selectors stay for older builds.
- Apple silicon only.

## Tests

```sh
(cd t3-extras && node --test test/*.test.mjs)
(cd t3-sidebar-keeper && node --test test/*.test.mjs)
```

## Status

- [x] Usage meters, burn tells, handover button and chain pill
- [x] Compact threads, sidebar polish, Fonts workspace with T3's own fonts
- [x] Sidebar sections: a "Pinned" label and line, older threads folded under one header, one-row titles that keep a trailing (N) — each with its own switch
- [x] Older threads section: threads last active more than 2 days ago (12 hours to 1 week, or Auto, in the ✦ panel) fold under one "Older than 2 days" header
- [x] Keeper units: wrap, minWidth, rule, fit, titleGuide, extras, firstClick, extrasOrigin, geminiQuota
- [x] Keeper `minWidth` supports nightly `0.1.8-nightly.20261106.4247`; older keeper/build combinations can still fail to apply the width patch
- [x] Compact sidebar usage in a short window (under 800 px tall)
- [x] Sidebar stays docked in a narrow window (under 768 px wide), with a switch to put T3's own auto-hide back (15 Nov 2026)
- [x] Fable's own weekly limit inside Claude's usage item: thin twin bar, label, chip, detail row (13 Nov 2026)
- [x] Claude without a 5-hour window: no tank or `5h` number in its item, and the legend names the tank only while a lab has one (13 Nov 2026)
- [x] Find fonts on screen: hover names the font area, Shift labels every area, a click opens Fonts beside the text, Show on screen — each with its own switch
- [x] Move popups out of the way: every popup drags by its top bar and reopens there; Fonts stops dimming, and its Small card sits clear of the text
- [x] About this font: a card while the font menu is open, a panel under Preview, a card beside "Your fonts" and a closed About in the docked card; eight more fonts with a new Rounded print group (13 Nov 2026, branch `font-details`, not yet installed)
- [x] Committed add-on tests cover usage, fonts and sidebar behavior (browser tests use the newest installed headless Chrome)
- [x] `geminiQuota` recognizes the corrected probe version in the November 6 nightly; the workaround remains for older builds
- [x] Sidebar hooks follow nightly 4736's title span and title-row model icons; keeper v16 wrap style 2 (15 Nov 2026)
- [x] `geminiQuota` follows the probe into the server bundle (November 13 nightly) and accepts any version from `2.24.0` up (keeper v15)

## Docs

- [SECURITY.md](SECURITY.md) — what this protects, and what it does not
- [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they are
- [docs/SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md) — history and a resume prompt

MIT licensed. Vendored [acorn](t3-sidebar-keeper/vendor/acorn/) keeps its own MIT license.
