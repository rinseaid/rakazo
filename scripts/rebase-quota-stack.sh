#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit or preserve pending changes before rebasing.' >&2
  exit 1
fi
branch="${1:-codex/quota-routing-rebase-$(date +%Y%m%d-%H%M%S)}"
case "$branch" in codex/*) ;; *) echo 'Use a codex/ revision branch.' >&2; exit 1 ;; esac
old_head="$(git rev-parse HEAD)"
git fetch upstream main
base="$(git merge-base "$old_head" upstream/main)"
new_base="$(git rev-parse upstream/main)"
# Preserve the previous stack and every published ref. Never force-push it.
git switch -c "$branch"
git rebase "$new_base"
git range-diff "$base..$old_head" "$new_base..HEAD"
if ! git diff --quiet "$base" "$new_base" -- pnpm-lock.yaml package.json; then
  echo 'Upstream dependencies changed. Install with the normal dependency policy, then run scripts/check-quota-stack.sh --full.' >&2
  exit 2
fi
bash scripts/check-quota-stack.sh --full
printf 'Verified revision branch: %s\nPublish explicitly with: git push fork HEAD\n' "$branch"
