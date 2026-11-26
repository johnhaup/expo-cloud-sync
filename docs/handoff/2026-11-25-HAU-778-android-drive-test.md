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

## Failed: Sign out does not sign out

Tapping **Sign out** (twice, and also "Sign out and delete synced copy") leaves the app `idle` and "Syncing as
haupenbusiness@gmail.com": signOut's own `syncNow()` ran (Last synced moved) and the silent `authorize(false)` still got
a token. After the wipe, sign-in went straight from the account picker to signed in with no consent screen, so the
`drive.appdata` grant survived `revokeAccess`. Nothing in logcat (release build; no exception from GMS logged).
Disproves the M5 assumption "silent `authorize` needs a resolution after `revokeAccess`".

Consequence: on Android a user can't stop syncing by signing out, and after "delete synced copy" the device keeps
syncing (its own rows are not re-uploaded, because signOut clears `_sync_rows` and the cursor, so it diverges from
the cloud until a row changes).

Next: check whether `revokeAccess(...).await()` throws or returns (log it in a debug build); if it returns and the
grant stays, keep a local signed-out flag (`_sync_meta`) that `account()` honours until the user signs in again,
rather than relying on Google to refuse the silent token. Add a bun test for "signed out stays signed out".

## Not run

- Two AVDs converging: only `runner` has the test account. The restore above covers download into a new device id.
- Switching accounts (`accountChanged`): one test account.
