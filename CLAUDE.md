# expo-cloud-sync — Claude Guidelines

`@johnhaup/expo-cloud-sync`: the shared record sync for John's expo-sqlite apps (HAU-760). iOS syncs rows
through the CloudKit private database, Android through the app's Google Drive appDataFolder. Merge logic lives
once in TypeScript; native code is a transport. The design, decisions and tickets (M1 to M7, A1 to A5) are in
`~/Projects/brain/plans/cloud-sync.md`: read it before changing anything structural. Recent work:
`docs/handoff/` (newest first).

## Commands

```bash
bun install && (cd example && bun install)
bun run typecheck    # src, plugin and example
bun run lint         # eslint (expo config)
bun test             # unit tests over bun:sqlite (src/__tests__)
bun run build        # build/ and plugin/build/ (committed)
bun run check:build  # fails if the committed build/ is stale
bun run check        # all of the above
```

## Rules

- **Never build on the MacBook Air** (no xcodebuild, `expo run`, compiling prebuild, simulators, Gradle, adb).
  Native builds and device checks run on mbp-1tb (iOS) and the Linux worker (Android).
- **`build/` is committed**: apps install this repo as a git dependency pinned to a tag, and bun runs no build
  step for it. Run `bun run build` and commit the result with every `src/` or `plugin/src/` change;
  `bun run check:build` must pass before a tag.
- Releases are tags (`v0.1.0`); apps move by changing the tag in their `package.json`. The repo is public
  (John, 2026-11-23), so apps depend on `github:johnhaup/expo-cloud-sync#<tag>`; it installs on the Air, mbp-1tb
  and the Linux worker. If it goes private again, bun can only fetch it over `git+ssh://`.
- `src/cycle.ts`, `src/install.ts`, `src/merge.ts` and `src/cloudSync.ts` never import `react-native` or the
  native module, so they run under `bun test`. Platform wiring lives in `src/create.ts`.
- Every change to the merge rules, triggers or cycle gets a test in `src/__tests__/`.
- Synced tables: `id`, `updated_at` (ms), `deleted_at` tombstone; app migrations on them are additive only.
