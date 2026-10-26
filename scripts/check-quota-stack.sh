#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Use packageManager from this checkout, including subprocesses in the native harness.
pinned_bin="$(mktemp -d)"
trap 'rm -f "$pinned_bin/pnpm" "$pinned_bin/pnpx"; rmdir "$pinned_bin"' EXIT
corepack enable --install-directory "$pinned_bin" pnpm
export PATH="$pinned_bin:$PATH"
corepack pnpm exec vitest run \
  packages/core/src/subscription-quota.test.ts \
  packages/contracts/src/model-usage-accounts.test.ts \
  apps/api/src/model-usage-accounts.test.ts \
  packages/adapters/src/model-quota.test.ts \
  packages/adapters/src/subscription-quota-observer.test.ts \
  packages/adapters/src/pi-runtime-fallback.test.ts \
  packages/adapters/src/pi-usage.test.ts \
  packages/db/src/run-turn-checkpoint.test.ts \
  apps/api/src/model-quota.test.ts \
  apps/api/src/model-quota-policy.test.ts \
  apps/web/src/components/usage/connection-quota.test.tsx \
  apps/web/src/components/usage/provider-quota-stack.test.tsx \
  apps/web/src/lib/localized-provider-hint.test.ts \
  apps/web/src/pages/ModelSettingsOverlay.test.tsx
for package in contracts core db adapter-kit adapters api web mobile; do
  corepack pnpm --filter "@rakazo/$package" exec tsc --noEmit -p tsconfig.json
done
if [[ "${1:-}" == "--full" ]]; then
  corepack pnpm exec tsx packages/testkit/src/cli/harness.ts --integration --spec=quota
  corepack pnpm exec tsx packages/testkit/src/cli/harness.ts --integration --spec=model-usage-accounts
  corepack pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec=model-quota.spec.ts
  corepack pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec=usage-accounts.spec.ts
fi
git diff --check
