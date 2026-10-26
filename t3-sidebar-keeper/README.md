# T3 sidebar keeper

> **Personal experiment.** I'm not a professional developer; I use T3 Code on my Mac for personal movie and Twitter projects. I made this to suit my own workflow. It isn't an official T3 Code project or a supported product.

Keeps sidebar-title changes in **T3 Code (Nightly)** across restarts and auto-updates:

- **wrap**: sidebar thread titles word-wrap instead of ending in "…" (cards, slim rows, drafts, search results, legacy rows).
- **minWidth**: the sidebar can be dragged down to 140 px (T3's own minimum is 208 px).
- **rule**: T3's title prompt asks for 2–5 words, under 36 characters (T3 says 3–8 words, under 40).
- **fit**: generated titles are capped at 40 characters and child/subagent titles at 42, cut at a word boundary, keeping a trailing `(model)` tag or `subagent N`; native subagent IDs become readable words, and shortened roles keep the word before a bare number. Upgrades the previous helper in place.
- **titleGuide**: appends one compact, replaceable `## Titles` section to every provider's orchestration instructions; starts after T3's next restart.
- **extras**: a tiny signed loader for the add-ons (usage displays, handover button, handwriting fonts, sidebar polish), which live in `../t3-extras/` and its loopback service. Install t3-extras first so `~/.local/share/t3-extras/loader-key.json` exists. Without that key the loader is not applied, and an older unsigned loader is taken out. Its bytes come out of the **wrap** style's padding, so it needs **wrap**. If the service isn't running, T3 just shows nothing extra. Added 19 Oct 2026.
- **firstClick**: the first click on an inactive T3 window also clicks what is under it, so one click opens a thread when you come back from another app. T3 leaves Electron's `acceptFirstMouse` off, so on a Mac that click only brought the window forward. Added 19 Oct 2026.
- **geminiQuota**: Gemini rows come back in Usage → Limits and the ✦ bar. T3's Antigravity limits probe calls itself `antigravity/hub/1.0.0`, and Google leaves the `gemini-5h` / `gemini-weekly` buckets out of its quota summary for that version (checked 26 Oct 2026 with T3's own request: only `3p-weekly,3p-5h` come back). The unit swaps in `2.24.0` in `binCli-*.mjs`, matched by the literal User-Agent text. It is server code, which T3 reads only at launch, so **each new build needs one quit-and-reopen (⌘Q) after the keeper has patched it** before Gemini shows. Nothing avoids that: there is no setting or environment variable for the version, the build can't be patched before its first launch (Gatekeeper), and a `NODE_OPTIONS` preload doesn't reach the server (Electron strips `--require` from a packaged app's `NODE_OPTIONS`, and refuses Node variables when another app starts the binary). Restart reminders are off on this Mac by request, so `--status` (unit `geminiQuota: patched`, set after the server started) is the way to tell. Upstream pingdotgg/t3code#22876; when T3 fixes it, the unit fails with "found 0 times" and can be deleted. Added 25 Oct 2026.

Every nightly update replaces the app, which wipes these changes. The keeper puts them back automatically.

## How it works

- `keeper.mjs` edits four files (`index.html`, `main-*.js`, `binCli-*.mjs` and the desktop `main.cjs`) inside `/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar` in place, keeping every file's byte length so nothing else in the archive moves. It finds what to change by stable markers (data attributes, a storage key, function names), not by the build's minified names, so it keeps working across builds. The CSS lives in a `<style>` added to T3's `index.html`; the room for it comes from deleting code comments, located with a real JavaScript parser (vendored acorn). If the add-ons loader needs more room, keeper v11 also removes indentation between boot-script tokens, preserving token contents and line breaks and checking token equivalence. Disabling the loader returns its bytes to style padding; reclaimed indentation stays compacted until an archive restore.
- A LaunchAgent (`com.cornishandy.t3-sidebar-keeper`) runs it every 30 seconds and whenever T3's server starts, at standard priority: with `ProcessType` Background, `Nice` 10 and low-priority I/O, a busy Mac kept the job stuck in launch for 4–5 minutes after T3 started (26 Oct 2026), while a run with nothing to do takes about 0.15 s. It rechecks an unhandled archive. A fresh install turns app-restart reminders off; an existing `restart-reminders-disabled.json` is left as it is. Reload notifications remain enabled.
- **It waits for each new build's first launch.** macOS Gatekeeper checks a new app version the first time it opens and blocks it ("damaged") if it was modified before then. That was tested on a copy on 18 Oct 2026. Patching after the first launch is fine. The keeper proves the first launch by checking (with `lsof`) that a running T3 process has that exact file open.
- **It swaps the file on disk atomically.** It patches an instant APFS copy, checks it, and swaps it in with one atomic rename, so a crash leaves either the old file or the new one, never a mix. The running T3 keeps the old copy open, so the keeper also writes the changed bytes of the two UI files into that copy (one write per file, put back if anything fails). That is what makes Shift-Cmd-R work without restarting.
- After patching it posts a notification. Press **Shift-Cmd-R** in T3 (View > Force Reload) to see wrapped titles straight away. The shorter-title rules and **firstClick** start when you next quit and reopen T3: they live in code T3 loads only at start-up (the server and the desktop window code, `apps/desktop/dist-electron/main.cjs`). So after each nightly update, the first-click fix is off until one more restart.
- macOS's **App Management** protection stops background jobs from changing apps. The job runs the Node binary recorded in `node-path` (mode 0600, the absolute path the installer found, not a resolved symlink). That binary needs **System Settings > Privacy & Security > App Management**. On the author's Mac that path is Homebrew's `node` (since 18 Oct 2026). A Node update that replaces the file can switch the grant off; the keeper then posts a notification saying so. The reminder helper reads `node-path` first, then its older Homebrew guesses. (A separate helper app would have been narrower, but macOS wouldn't let it be added to that list.)

## Safety

- Refuses to patch if Electron's asar-integrity check is turned on in a future build (patching would stop T3 starting).
- Re-checks right before writing that the app hasn't changed, and that there is at least 1 GB free.
- Saves the original bytes per build in `~/.local/share/t3-sidebar-keeper/backups/` (last 3 builds).
- `--restore` only undoes the exact file the keeper wrote; after a T3 update or reinstall there is nothing to restore. Quit and reopen T3 afterwards. The keeper leaves a restored build alone and patches again at the next T3 update.
- Each part applies fully or not at all. If a future build changes too much, that part is skipped and a notification names it.
- If a denied write or other error happens, it waits 10 minutes before trying the same build again. `keeper.log` rotates at 1 MB.
- Changing the CSS: bump the number in `STYLE_ID` (`t3-keeper-sidebar-1`); a build that already has an older keeper style needs `--restore` first.
- Changing the add-ons loader: bump the number in `EXTRAS_ID` (`t3x-boot-2`); an older loader is replaced in place. The loader verifies `extras.js` and `extras.css` before inserting them. A bad signature inserts nothing.

## Commands

```bash
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --status    # what's patched, first-launch check, fuse state
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --dry-run   # patch a temporary copy and report
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --apply     # patch now (works from a T3 terminal or agent)
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --restore   # put this build's original bytes back
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --disable extras   # take only the add-ons loader out (then Shift-Cmd-R)
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --enable extras    # put it back
tail ~/.local/share/t3-sidebar-keeper/keeper.log             # what the background job did
```

`--disable` / `--enable` work for **extras**, **rule**, **fit** and **titleGuide** (kept in `disabled.json`, so the choice stays across nightly updates). **extras** comes out on the next apply. **rule**, **fit** and **titleGuide** are left out of the next build, but a build that already has them keeps them until `--restore`. Status then says they are switched off and still in the app until `--restore`. wrap, minWidth, firstClick and geminiQuota are undone only by `--restore`. If T3 isn't running that build, the switch is applied once it starts.

To pause it: `launchctl bootout gui/$(id -u)/com.cornishandy.t3-sidebar-keeper`. To resume: run `install.sh` again.

## Install, update, uninstall

```bash
# Install t3-extras first, so the add-ons loader has a public key.
./install.sh              # copies keeper.mjs + vendor/ to ~/.local/share/t3-sidebar-keeper and loads the job
./install.sh --uninstall  # removes the job; T3 stays patched until --restore
node --test test/         # local-only tests (a temporary copy of the installed app.asar; they do not write the app)
```

You need Apple silicon and Xcode Command Line Tools (`swiftc` and `clang`). The helper is compiled on every install. A fresh install (no `keeper.mjs` and no `disabled.json`) writes `disabled.json` with `rule`, `fit` and `titleGuide` off, and writes `restart-reminders-disabled.json`, before the new code is published. A retry that finds `defaults-pending` finishes those files and does not replace a `disabled.json` that is already there. An existing install is not given those defaults.

`keeper.mjs` in this folder is the source. The background job runs the installed copy, so re-run `install.sh` after editing it. Re-running writes `node-path` again. It does not change an existing `disabled.json` or an existing reminder opt-out.

## App restart reminders are disabled

Andy opted out on 21 Oct 2026. The persistent file `~/.local/share/t3-sidebar-keeper/restart-reminders-disabled.json` disables the scheduler, notification submission, native helper windows, setup and Resume. It is user state, so app updates and keeper reinstalls do not replace it. Existing helper notifications are cleared. Reload notifications still say to press Shift-Cmd-R; no T3 app restart is requested.

The remaining notes describe the dormant helper implementation, not an active reminder service.

After a patch that T3 only loads at startup (the title rules, the length cap, or the first-click fix), the same 30-second job reminds you until you snooze it or quit and reopen T3. The first reminder is immediate, then one every 15 minutes. Snooze defaults to 3 hours. Nothing in this job quits or restarts T3 for you.

The wording and the buttons live in `T3 Restart Reminders.app` next to the keeper. Snooze and the repeat interval are yours: they survive the next update and a reinstall. Closing a notification does not snooze it. To keep the buttons on screen, choose Alerts in Notification Settings.

```bash
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --reminders          # JSON status
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --snooze 3h          # or 90m, 1h, …
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --resume-reminders   # one reminder now if a restart is still needed
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --remind-every 15m   # 5 minutes through 24 hours
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --reminder-controls  # the window; it never quits T3
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --reminder-setup     # ask for notification permission
```

Re-run `install.sh` after editing `keeper.mjs`, `reminders.mjs`, or the helper. That replaces the code and reloads the job. It leaves the snooze, the interval, backups, and the log where they are.

Only explicit setup can ask for notification permission. The background timer and status commands never ask. Installation, authorization, and an accepted notification submission are separate; Focus and macOS notification settings can still hide an accepted reminder. Open the controls window for the same snooze and interval choices as the notification. Custom intervals are whole minutes from 5 to 1440; custom snoozes from 1 to 43200. Resume ends the snooze and lets the next 30-second check submit one immediate reminder. Repeated snooze starts from now, and changing the interval anchors the next reminder to the last accepted submission.

The keeper journals its intended archive before publication. Recovery never turns an uncommitted clone into a reminder. Completion requires positive evidence of a replacement desktop main starting after publication and opening the target archive, with no old main surviving. A backend-only restart, an absent app, uncertain timestamps, or an old main opening the new archive do not complete it. Ambiguous legacy history stays quiet and is reported in JSON status. A crash with an unknown publication time conservatively waits for a main born after recovery.

The installer builds and validates first, then pauses the existing LaunchAgent and drains native actions before replacing code under a shared code lease. Any replacement failure restores compatible code. Mutable reminder state is never included in rollback. Each successful install prints a retained code backup in `~/.local/share/t3-sidebar-keeper/install-rollback/`; after checking the installed helper, keep or remove that specific backup. To restore it while keeping the current snooze/settings:

```bash
./install.sh --rollback /absolute/path/to/the/retained/code/backup
```

For an isolated native button test, use the module's explicit diagnostic namespace. It is a single fixed `reminders-diagnostic.json` sibling of the installed helper, never polled by the LaunchAgent; an OS-cold-launched action resolves it without inherited environment variables. The production record is never replaced or snapshotted. Use a `test-` generation, post it, click its real notification button, inspect the diagnostic status, then clean up that same generation only:

```bash
node ~/.local/share/t3-sidebar-keeper/reminders.mjs --diagnostic-create --namespace diagnostic --generation test-native-buttons
node ~/.local/share/t3-sidebar-keeper/reminders.mjs --diagnostic-post --namespace diagnostic --generation test-native-buttons
node ~/.local/share/t3-sidebar-keeper/reminders.mjs --reminders --namespace diagnostic
node ~/.local/share/t3-sidebar-keeper/reminders.mjs --diagnostic-cleanup --namespace diagnostic --generation test-native-buttons
```

The diagnostic cleanup refuses a different generation and clears only its own native request. It cannot clear production notifications. A stale action or busy/write failure returns a structured nonzero result; the native helper never shows it as saved. Background action failures open Controls and append a report to `reminder-helper.log` beside the installed module. Tests use fake homes and scratch bundles, never the production log or reminder record.

Already-patched replacements also reconcile a pending restart: even if the keeper commits no files, a positively identified different current archive/build gets a fresh generation and a conservative first-observation boundary. Root snooze/settings survive; an already-running main or unknown evidence cannot clear the replacement. A later genuine desktop main must open that target. This does not change the keeper's separate produced identity used for safe `--restore`.

Native admission uses a shared lifetime lease on the permanent `native.flock` inode, with maintenance/token checks before and after acquisition. The installer takes it exclusively before changing code, for both installation and rollback. An embedded build token must match the current installed bundle token, so a delayed old executable image cannot join after replacement. Uncooperative legacy helpers observed late cause refusal with code unchanged; compatibility process scans supplement the lease rather than replace it. Headless post/status/clear never create AppKit's application or install its notification-response delegate. Passive interactive responses, including cold Dismiss and invalid payload, call completion then exit when no Controls or other action remains.

For the parent's real OS overlap acceptance, the diagnostic-only command below holds a successful posting invocation for eight seconds. It writes `reminder-diagnostic-overlap.json` beside the installed module while that helper is active; the marker includes its PID and the test generation. Normal production posting is immediate. Interactive actions retry explicit contention within an 18-second total budget, permitting a successful overlap; maintenance still fails visibly. Actual OS delivery during overlap remains a native acceptance test, not a mock claim.

```bash
node ~/.local/share/t3-sidebar-keeper/reminders.mjs --diagnostic-post --namespace diagnostic --generation test-native-buttons --overlap-seconds 8
# While the above command is still running, inspect this marker in another terminal
cat ~/.local/share/t3-sidebar-keeper/reminder-diagnostic-overlap.json
# Click the real diagnostic notification's Snooze action while its helper PID is alive
```

The overlap option only accepts 1..10 seconds in the fixed diagnostic namespace and matching `test-` generation. The marker disappears after the hold; matching diagnostic cleanup also removes a stale marker. Cold/warm Dismiss and an explicit busy failure remain separate real OS probes.
