# HAU-792: a new install's first download wins (2026-11-24)

Tag `v0.4.1`. Plan: `~/Projects/brain/plans/cloud-sync.md`, "Conflict rules" rule 8 (added with this change).

## The bug

Found in the Plate Weight reinstall test (HAU-788). A reinstalled app that saves a settings row before its first
fetch (Plate Weight's `-skipTips` launch, or a user closing a tip in the first seconds) stamped that row newer than
the iCloud copy. Whole row, newest wins: the install's defaults replaced the cloud's settings on every device.
Holding uploads alone would not fix it: on the fetch, `decide` still kept the newer local row.

## The change

- `installSyncWith`: a database with no `device_id` at all (never synced: a new install or a reinstall) gets
  `_sync_meta.fresh = 1`. A restore (another install's id) does not, so a restored backup still wins when newer.
  Adopting an account, turning sync on again and a deleted zone also keep the normal rule.
- `decide(local, remote, fresh)`: while fresh, the remote record always wins (`same` only when identical).
  Used by `mergeRecords` and `settleConflict`, so a save that hits `serverRecordChanged` settles to the server too.
- Fresh ends after the first complete fetch: Android after `pull` finishes in `runCycle`; iOS on
  `didFetchChanges`, which native now emits as `{ type: "didSync", fetched: true }` (`didSendChanges` stays
  `didSync` without it). A failed pull leaves it fresh.
- Rows the cloud does not have (a custom plate added in those seconds) still go up.
- Test fixture: `openDevice` clears `fresh` unless `{ fresh: true }`, since most tests model devices that
  already synced. New tests in merge, install, cycle and engineSync.

## Verified

On mbp-1tb's `CloudSync Test` simulator (John's Apple ID), a Release build of Plate Weight `7eef731` pinned to
this commit, against the iCloud copy left by the HAU-788 test (25s off, custom 33 bar, 1.25 plate deleted):
- Reinstall launched with `-skipTips`: settings stay as in iCloud (25s off), `fresh` cleared, nothing pending.
  A clean reinstall after it shows iCloud unchanged.
- After the first fetch, turning the 35s off syncs, and a reinstall brings 35s off back.

## Trade-off

A device that never synced and is used offline before its first fetch loses same-key rows (settings) to the
cloud copy; its own new rows (shifts, notes, custom plates) are kept. Also an app already installed before it
adopted the module counts as new on its first sync. Accepted: a reinstall overwriting the cloud is the worse case.

## Not verified

Android (Drive) on a device; the change there is the same `pull` then `endFresh` path, covered by `cycle.test.ts`.
