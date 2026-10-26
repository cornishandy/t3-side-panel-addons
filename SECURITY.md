# Security

> **Personal experiment.** I'm not a professional developer; I use T3 Code on my Mac for personal movie and Twitter projects. I made this to suit my own workflow. It isn't an official T3 Code project or a supported product.

This is for a Mac where every account is trusted. On a shared Mac, do not install these add-ons and do not run the service. The ✦ switches give no confidentiality. Turning a meter or a burn tell off does not stop the page from asking, and it does not stop the service from answering.

## What another account on this Mac can do

The service listens on `127.0.0.1:8793`. Loopback is shared by every account. While the service is running, another account can read its replies. While it is stopped, another account can listen on that port, receive the requests, and answer them.

What they can read or fake:

- Usage numbers and the usage history the service keeps.
- Thread IDs, including the current thread. The page polls `/state?thread=` about once a minute while T3 is visible (`POLL_MS` is 60 seconds), whether or not a switch is on.
- Burn tiers from `/burn`.
- Handover chain data, including the handoff file path, when `~/.claude/bin/handover` exists and its state file is present.
- Thread titles and project labels from `/grouping` (`title`, `projectId`, `projectLabel`). The page uses that route for sidebar gap times. The installer does not copy `grouping.js` into T3, but the route still answers.

A fake listener can send fake numbers, tiers and chain labels. It cannot put code into T3. The loader checks a signature first and inserts nothing when the check fails. The one exception is replay: a fake listener can serve an older pair of `extras.js` and `extras.css` that this install really signed. That older pair is still the author's code, not an attacker's.

Host and Origin checks are browser defences only. They are not proof of which account connected. There is no peer-account check.

## What the signature covers

`t3-extras/install.sh` creates an ECDSA P-256 key once: `signing-key.pem` (private, mode 0600) and `loader-key.json` (the public key). It signs the UTF-8 bytes of `JSON.stringify(["t3x1", version, css, js])`. The signature is `public/extras.sig`. The private key is used only by the installer.

The keeper's loader (`t3x-boot-2`) embeds that public key and verifies the same JSON with `crypto.subtle` (ECDSA P-256, SHA-256, IEEE-P1363) before it inserts the style and the script. A bad signature, a missing signature, another key, a swapped css/js field, or one changed byte inserts nothing.

If `loader-key.json` is missing but the private key is valid, the next install derives the public key. If the two files do not match, or the private key is a symlink, or it is not mode 0600 and owned by you, the installer refuses and does not write a new key. If the public key is missing at patch time, the keeper does not leave the old unsigned loader (`t3x-boot-1`) in place. That unit stays out and status says to install t3-extras first.

The signature is over `extras.js` and `extras.css` alone. If you later put `grouping.js` or `grouping.css` beside them, the service appends those bytes and the signature no longer matches, so the loader inserts nothing.

## What the service reads

On this Mac, read only:

- T3's state database `~/.t3/userdata/statev2.sqlite` and the environment id `~/.t3/userdata/environment-id`.
- T3's usage rates, settings and scan cache: `~/.t3/userdata/usage-model-rates.json`, `settings.json` and `usage-scan-cache-v5.json`. The scan cache is read, not deleted.
- Transcripts for burn tells: `~/.claude/projects`, `~/.codex/sessions`, `~/.codex-t3-api/sessions` (the author-only Codex API tree) and `~/.grok/sessions`. A whole record is read into memory. Only usage fields are kept. Nothing from those files is sent off the Mac by this service.
- Optional tools, only when the file is executable: `~/.claude/bin/lab-usage` (`T3X_LAB_USAGE`) and `~/.claude/bin/handover` (`T3X_HANDOVER_BIN`). Handover state is `~/.local/share/handover/state.json`. A missing tool is not spawned and is not reported as a failure.
- Inside T3's window, T3's own saved quota readings (IndexedDB `t3code:connection-runtime`), read only, and only if that database already exists.

A missing transcript directory is no data, not an error.

## What it writes

Under `~/.local/share/t3-extras` (mode 0700): `usage-history.jsonl`, `diag.log`, `server.log`, the signing key, and the installed code. `/diag` stores automatic first-load version reports locally, plus the opt-in debug counts. Under `~/.local/share/t3-sidebar-keeper` (mode 0700): `keeper.log`, `node-path`, backups, and the reminder helper's own files.

`diag.log`, `usage-history.jsonl` and `keeper.log`, including rotation and compaction, are opened with `O_NOFOLLOW` and set to mode 0600 through the opened file. A symlink is not followed. launchd itself opens `server.log` and `keeper.log` for each job's output; before starting the job, its installer replaces a symlink there with a regular file and sets it to 0600. Parent directories are the protection for the other files; this note does not claim every file in those directories is mode 0600.

Inside T3, the add-ons store `t3x:settings:v1`, `t3x:diag` and `t3x:reported-version` in localStorage, and samples in IndexedDB `t3x-usage-history` (never T3's database). The client removes `t3x:dev-until` only. Uninstall does not delete those.

## Network

The installer downloads font files once, over https, and checks each sha256. The hosts are `fonts.gstatic.com` and `raw.githubusercontent.com` (the licence texts at one pinned Google Fonts commit). There is no telemetry. `lab-usage` and `handover`, if you have them, do whatever they do on their own. This service does not call them for the network.

## Patching T3

The keeper edits `app.asar` in place. That invalidates the app's code signature. Gatekeeper checks a new build the first time it opens and can report the app as damaged if it was modified before that first launch, so the keeper waits until a T3 process has that build open. The archive swap is one atomic rename of an APFS copy. After that, the keeper also writes the changed bytes into the copy the running app still has open, so a reload can see them. Those in-place writes are not a second atomic swap.

The loader and the other keeper edits run inside T3's renderer and main process, with the privileges that process already has. They are not a sandbox escape, and they are not a reduction of T3's privileges either.

App Management, granted to the Node binary the installer prints, lets that binary change other apps. Any script you run with that same binary can too. A version manager can replace the file at that path; the installers warn and still use the path they found, without resolving it.

Apple silicon only. The reminder helper is built for arm64. The keeper installer compiles that helper every time and needs Xcode Command Line Tools (`swiftc` and `clang`); there is no skip. The add-ons installer checks for the same tools up front, so a missing toolchain shows before anything is installed.

## Uninstall

Restore the archive before you delete anything:

```sh
node ~/.local/share/t3-sidebar-keeper/keeper.mjs --restore
t3-extras/install.sh --uninstall
t3-sidebar-keeper/install.sh --uninstall
```

`--restore` only puts back the bytes for this build. After a T3 update there is nothing to restore. Then delete the localStorage and IndexedDB keys named above if you want them gone.

## Reporting, history, secrets

Report a vulnerability privately, through GitHub private vulnerability reporting on this repository. This file does not claim that setting was checked and found on.

Git history is kept as it is. A gitleaks scan of this directory and of the git history found no credentials. If a real credential were in the history, deleting the line would not be enough. It would have to be revoked.

Keeper tests that read `/Applications/T3 Code (Nightly).app` or `~/.local/share/t3-sidebar-keeper/backups` are local-only. They clone with `cp -c` and do not write those files. The known `minWidth` failure on T3 0.1.3 is in the root README under Known issues.
