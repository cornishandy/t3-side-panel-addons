# Session handoff

## History

- 18 Oct 2026: sidebar keeper built (wrap, minWidth, rule, fit, titleGuide).
- 19 Oct: t3-extras add-ons service, ✦ panel, usage displays, handover button and pill, handwriting fonts; keeper units `extras` and `firstClick`.
- 20 Oct: usage round 2 (pace glyph with 5-hour tank, run-out strip), burn tells, reply-footer card CSS, stronger Working divider, selected-thread marker.
- 21–22 Oct: sidebar grouping experiments; 18-area Fonts workspace.
- 24 Oct: "Your fonts" list in the ✦ panel.
- 25 Oct: compact threads, T3's own fonts in font menus, grouping bar removed, keeper `geminiQuota` unit (KEEPER_VERSION 12). Moved from a scratch folder into this repo. Sidebar sections (pinned label, fold older, one-row titles, gaps by time). Find fonts on screen (hover, Shift labels, docked Fonts card, Show on screen).

## Where things live

- Source: this repo. Installed copies: `~/.local/share/t3-extras/` and `~/.local/share/t3-sidebar-keeper/` (re-run each `install.sh` after editing).
- LaunchAgents: `com.cornishandy.t3-extras`, `com.cornishandy.t3-sidebar-keeper`.
- `keeper.mjs --status` shows the keeper's state.

## Resume prompt

> Continue work on the T3 side-panel add-ons in this repo. Read README.md, docs/DECISIONS.md and both part READMEs first. Re-read `t3-sidebar-keeper/keeper.mjs` from disk before editing it, add any new app.asar patch as a keeper unit matched by stable markers, run both test suites, re-run the relevant `install.sh`, and push.
