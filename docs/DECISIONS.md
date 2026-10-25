# Decisions

- **18 Oct 2026 — keep patches alive with a keeper, not by hand.** Each nightly update wiped hand patches (three on 18 Oct). The keeper patches only a build a running T3 already has open, because changing a build before its first launch makes Gatekeeper call it "damaged". It swaps in a patched clone atomically and live-writes the UI files, so Shift-Cmd-R shows changes.
- **18 Oct — match by stable markers, never minified names,** so units survive new builds; a unit that can't match is skipped with a notification.
- **19 Oct — add-ons served by an always-on, Mac-only loopback server** (approved: "Yes, Mac-only"). T3's renderer has a header CSP that blocks remote `<script src>`, so a 628-byte inline loader fetches the code and inlines it. Every endpoint requires Origin `t3code://app`.
- **19 Oct — every add-on gets its own switch** in the ✦ panel, so any one can be undone.
- **19 Oct — firstClick unit:** the first click on an inactive T3 window should open the thread under it (Electron `acceptFirstMouse`).
- **20 Oct — usage reads are read-only:** T3's IndexedDB is opened read-only and closed at once; `lab-usage --json --read-only` takes no lock and writes nothing.
- **24 Oct — font names belong in the ✦ panel, not the main chat screen** ("TOO prominent").
- **25 Oct — only T3's native thread list:** the Group / Sort / Native views bar was removed (code kept, not installed). Compact threads added, on by default, with a switch.
- **25 Oct — geminiQuota unit:** T3's Antigravity limits probe sends a User-Agent version for which Google omits the Gemini buckets; the unit sends `2.24.0`. Upstream: pingdotgg/t3code#22876.
- **25 Oct — published as its own public repo** after a privacy pass: home paths and the Mac's tailnet name replaced, iCloud conflict copies and test screenshots left out, gitleaks clean.
- **25 Oct — compact sidebar usage in a short window:** the four-lab block took too much room when the window was squished vertically. Under 800 px tall it becomes one line per lab (on by default, with its own switch).
