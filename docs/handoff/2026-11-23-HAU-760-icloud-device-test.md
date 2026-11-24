# HAU-760: first iCloud test against CloudKit (2026-11-23)

Plan: `~/Projects/brain/plans/cloud-sync.md` ("CKSyncEngine", "Testing"). Module `v0.4.0`, unchanged: no bugs found, no new tag.

## Setup

- mbp-1tb, Xcode 27.1, simulator "CloudSync Test" (`A41EF4FC-…`, iOS 27.0) signed into John's Apple ID. Only that
  simulator was used; it is shut down again, with the example app still installed.
- A scratch clone of `v0.4.0` on mbp-1tb (deleted after), `expo prebuild -p ios`, `pod install`, then a signed Release
  build for that simulator (JS bundled, no Metro):
  `xcodebuild -workspace CloudSyncExample.xcworkspace -scheme CloudSyncExample -configuration Release
  -destination id=<udid> CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=EKHA8NK939 -allowProvisioningUpdates
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_2B672G8285.p8 -authenticationKeyID 2B672G8285
  -authenticationKeyIssuerID <the runner's asc.issuer> build`.
  Simulator builds sign "to run locally" with the entitlements embedded in the binary's `__entitlements` section
  (`application-identifier EKHA8NK939.com.johnhaup.cloudsync.example`, the container, CloudKit, `aps-environment`).
  That is enough for CloudKit on a simulator: no provisioning profile was needed.
- Observed with `simctl spawn <udid> log stream` (subsystem `com.apple.cloudkit`, the engine's "will post event" lines),
  the app's `icloud.db` read with `sqlite3` from the app container, Maestro (`--device <udid>`) to type, and screenshots.
  The container ran in the Development environment (`environment=Sandbox` in CloudKit's logs).

## Results

1. **Build with entitlements**: pass (above).
2. **Upload**: pass. First launch: account available, `account_id` stored, zone `Sync` saved (the very first zone save
   took 31 s), engine state persisted to `_sync_meta.cursor`. Three notes added: three `SentRecordZoneChanges` with
   `Row notes/<id>` saved (etags 3, 4, 5), no failures; `_sync_rows` 3 with `sys`, `_sync_changes` 0; UI "idle · 0
   pending", "Last synced". The `Row` record type was created just-in-time in the Development schema.
3. **Reinstall**: pass. `simctl uninstall` + install: new device id, sync on by default, the same three notes came back
   (`FetchedRecordZoneChanges` with all three), 0 pending.
4. **Edit and delete**: pass. On the reinstalled app, an edit (saved on the fetched record's change tag, etag 3 to 7,
   no conflict) and a delete (tombstone, etag 6). Reinstall again: the edit shows, the deleted note is hidden and its
   row has `deleted_at`.
5. **Extra, restore onto a new phone**: pass. With the app stopped, the native device file was overwritten
   (`restored-test-0000`). Relaunch: restore detection, a first sync with every row dirty and no `sys`; all three saves
   came back `serverRecordChanged`, `settleConflict` took the server's change tags, 0 pending, notes unchanged.
6. **Extra, "Turn off and delete iCloud copy", then "Sync on"**: pass. The zone was deleted (`CKModifyRecordZonesOperation`
   with `zonesToDelete`), state `off`, `enabled = 0`, `_sync_rows` empty, notes kept. Sync on: zone recreated, all three
   rows uploaded again, 0 pending.

## Watch out for

- After step 6 each row went up twice: the fresh engine's first database fetch reports the zone deletion this device
  made (`reason=deleted`), native emits `zoneDeleted`, JS re-marks and hands every row over while the first save is in
  flight; the second save comes back `serverRecordChanged` and settles. Correct result, one extra round trip per row,
  only after a delete-copy and re-enable on the same device. Not fixed.
- The first zone save on a new container can take about 30 s; the status shows "idle" without "Last synced" until then.

## Unverified

- Two simulators exchanging notes live, later edit wins across devices, offline edits on both, iCloud sign-out
  (`signedOut`). Needs a second simulator signed into the same Apple ID (John) or a test Apple ID.
- Push delivery: nothing in this test needed it (every change was seen through a launch or the engine's own schedule).
- Production environment: TestFlight builds cannot save until John deploys the schema (below).

## For John

CloudKit Console, container `iCloud.com.johnhaup.cloudsync.example`: the Development schema now has record type `Row`
(fields `t`, `u`, `v`, `p`). "Deploy Schema Changes" to Production only if the example app will ever run from
TestFlight; for the apps, do it once per app container after its first dev build saves a record. The three test notes
(two live, one tombstone) are in the Development private database, zone `Sync`.
