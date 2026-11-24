#!/usr/bin/env bash
# build/ and plugin/build/ are committed: a git dependency runs no build step under bun.
# Rebuilds them and fails if the result differs from what is committed.
set -euo pipefail
cd "$(dirname "$0")/.."
bun run build >/dev/null
if [ -n "$(git status --porcelain -- build plugin/build)" ]; then
  git status --short -- build plugin/build
  echo "build/ is stale: run 'bun run build' and commit the result." >&2
  exit 1
fi
echo "build/ is fresh."
