# HAU-778: first Android run against Google Drive (2026-11-25)

M5's acceptance on the Linux worker, with the example app at `ea88026` (v0.4.1). Release APK (x86_64, signed with the
RN debug key `5E:8F…F6:25`, which has an Android client in the "Cloud Sync Example" Google Cloud project, in Testing)
on the `runner` AVD (API 35 google_apis), signed into the test account `haupenbusiness@gmail.com`. Built in a scratch
copy, deleted after; the app was uninstalled again.

## Passed

- **Sign in**: Sign in with Google → account picker → "Google hasn't verified this app" (expected while the project is in
  Testing) → consent for only "its own configuration data in your Google Drive" → `idle`, "Syncing as
  haupenbusiness@gmail.com". Expo's activity result registry delivers the consent result (an M5 assumption).
- **Write and restore**: two notes, Sync now, 0 pending. `pm clear`, relaunch (new device id), sign in: both notes back.
- **Delete synced copy**: after "Sign out and delete synced copy", `pm clear` and sign in show "No notes yet.", so
  appDataFolder was emptied.

## Failed, then fixed in v0.4.2: Sign out did not sign out

Tapping **Sign out** left the app `idle` and "Syncing as haupenbusiness@gmail.com". Cause, found with logging in a
scratch copy: `revokeAccess(...)` never completes on this emulator's Play services (24.23.35, mid-2024; neither
success nor failure after 20 s), so `signOut()` hung before it changed anything. "Delete synced copy" still worked
because `wipe()` runs before the revoke. Google also kept the grant: after a wipe, sign-in skipped the consent screen.

Fix (`9f1df55`, then the commit tagged `v0.4.2`): signed out is the device's own `_sync_meta.signed_out`, set before the
revoke; the cycle reports `signedOut` while it is set and `signIn()` clears it. The revoke is best effort, capped at
`REVOKE_WAIT_MS` (5 s). The fake Drive's revoke now keeps the grant, and `revokeHangs` reproduces the hang; two new
tests. On the device: Sign out returns after 5.0 s, `signedOut`, still `signedOut` after a relaunch, and Sign in syncs
again.

## Watch out for

- **The example app bundles `../src`, not `build/`** (`example/tsconfig.json` paths, which Expo's Metro honours). A
  scratch copy on the worker needs the current `src/`; copying only `build/` tests the old code.
- The worker's shell is zsh: `$CMD args` in a variable does not word-split; use a function.
- The emulator's Play services lag real phones. Anything Google-side the module waits on needs a timeout.

## Not run

- Two AVDs converging: only `runner` has the test account. The restore above covers download into a new device id.
- Switching accounts (`accountChanged`): one test account.
