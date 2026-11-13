# Session handoff

## History

- 7 Nov: ✦ panel "Your fonts" rows get − n% + size buttons (5% steps, 80–150%, the source area's size); the 26 Oct "Use for similar" option committed.
- 7 Nov: Andy requested unrestricted sidebar title rows. Added No limit beside 2/3 lines under compact threads, with One-row titles off. Saved setting "unlimited" disables the CSS line clamp; existing defaults remain. 58 targeted core/browser tests passed; narrow 160px sidebar shows the full long title and preserves choice across the one-row switch. Installed only the narrow title patch into the existing signed bundle; no service/app restart, no key change. That session left it uncommitted; the font-size thread committed and pushed it the same morning.
- 7 Nov: popups move out of the way (Andy picked "Drag + small card" from a mock): ⠿ on every popup's top bar, spots remembered, no dark wash in Fonts, and a Small card button that places the card clear of the area's text; switch `popMove`. Astra pre-OK; 241 add-on tests pass.

- 18 Oct 2026: sidebar keeper built (wrap, minWidth, rule, fit, titleGuide).
- 19 Oct: t3-extras add-ons service, ✦ panel, usage displays, handover button and pill, handwriting fonts; keeper units `extras` and `firstClick`.
- 20 Oct: usage round 2 (pace glyph with 5-hour tank, run-out strip), burn tells, reply-footer card CSS, stronger Working divider, selected-thread marker.
- 21–22 Oct: sidebar grouping experiments; 18-area Fonts workspace.
- 24 Oct: "Your fonts" list in the ✦ panel.
- 25 Oct: compact threads, T3's own fonts in font menus, grouping bar removed, keeper `geminiQuota` unit (KEEPER_VERSION 12). Moved from a scratch folder into this repo. Sidebar sections (pinned label, fold older, one-row titles, gaps by time). Find fonts on screen (hover, Shift labels, docked Fonts card, Show on screen).
- 31 Oct: the Older threads section folds by a set age (default 2 days; 12 hours to 1 week or Auto in the ✦ panel), under an "Older than 2 days" header shaped like T3's shelf headers.

- 6 Nov: keeper v14 supports Nightly .4247: runtimeLayer/server split, shared sidebar minimum, server indentation reclaim. Native title setting compared; Andy chose to keep rule/fit/titleGuide in the keeper and leave native threadTitleInstructions unset. Gemini version is already 2.24.0 upstream in this build.
- 9–12 Nov: a showcase page of the sidebar title rules was built for T3 Code's maintainers (page, ten screenshots of invented threads, a README picture). Not published and not sent: on 12 Nov upstream said it takes only bug fixes from outside (see DECISIONS, 12 Nov). The page is parked on the local branch `sidebar-titles-page`, unpushed. Before any reuse: it shows an invented 101-character title and wrongly calls it a failed title (a design round settled on an invented 40-character one, labelled as invented; never built), and with thread burn tells on, the burn chip covers most of a compact-row title at 256 px (a bug, not fixed).
- 12–13 Nov: Fable's own weekly limit added to Claude's usage item (thin twin bar in every glyph, label, chip, detail row, strip line, stop tick; see DECISIONS, 12–13 Nov, and the Usage section of t3-extras/README.md). Tests: `test/fable-usage.test.mjs` and `test/fable-browser.test.mjs` (the production renderers at the app's font). 324 add-on tests pass.

## Where things live

- Source: this repo. Installed copies: `~/.local/share/t3-extras/` and `~/.local/share/t3-sidebar-keeper/` (re-run each `install.sh` after editing).
- LaunchAgents: `com.cornishandy.t3-extras`, `com.cornishandy.t3-sidebar-keeper`.
- `keeper.mjs --status` shows the keeper's state.

## Resume prompt

> Continue work on the T3 side-panel add-ons in this repo. Read README.md, docs/DECISIONS.md and both part READMEs first. Re-read `t3-sidebar-keeper/keeper.mjs` from disk before editing it, add any new app.asar patch as a keeper unit matched by stable markers, run both test suites, re-run the relevant `install.sh`, and push.
