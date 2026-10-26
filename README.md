# T3 side-panel add-ons

Personal customizations for the sidebar (side panel) of **T3 Code (Nightly)** on macOS. Two parts, kept together because each needs the other:

- **[`t3-extras/`](t3-extras/README.md)** — the add-ons themselves, behind a **✦** button in the sidebar's bottom row: usage meters for each AI lab (Claude, Codex, Gemini, Grok), thread "burn" tells, a Prepare handover button and handover chain pill, compact thread rows and other sidebar polish, an 18-area Fonts workspace, and the reply-footer card styling. Each add-on has its own switch. A small Node server on `127.0.0.1:8793` (loopback only, every request must come from T3's own `t3code://app` origin) serves them.
- **[`t3-sidebar-keeper/`](t3-sidebar-keeper/README.md)** — a LaunchAgent that re-applies small patches to T3's `app.asar` after every nightly update: wrapping sidebar titles, a 140 px minimum sidebar width, shorter generated titles, the tiny loader that pulls in the add-ons, first-click click-through, and a Gemini quota fix.

These are built for one person's Mac and T3 Nightly builds. They patch an Electron app in place, so read both READMEs before installing; nothing here is supported by the T3 Code project.

## Install

```sh
t3-sidebar-keeper/install.sh   # patches T3 after its first launch of each build
t3-extras/install.sh           # starts the loopback add-ons service
```

Turn things off from the ✦ panel switches, or: `t3-extras/install.sh --uninstall`, `node ~/.local/share/t3-sidebar-keeper/keeper.mjs --disable extras`, `keeper.mjs --restore`.

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
- [x] All 204 add-on tests pass (browser tests use the newest installed headless Chrome)
- [ ] Delete `geminiQuota` once T3 fixes pingdotgg/t3code#22876

## Docs

- [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they are
- [docs/SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md) — history and a resume prompt

MIT licensed. Vendored [acorn](t3-sidebar-keeper/vendor/acorn/) keeps its own MIT license.
