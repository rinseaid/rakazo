import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query";
import { ConnectionQuota } from "./connection-quota";

export function ProviderQuotaStack({ compact = false }: { compact?: boolean }) {
  const queries = useSpaceQueries();
  const credentials = useQuery({ ...queries.models.credentials.queryOptions({}), retry: false });
  // OAuth connections intentionally do not set the API-key flag.
  const connected = (credentials.data ?? []).filter(
    (credential) => credential.hasKey || credential.authKind === "oauth",
  );
  return (
    <div data-testid="provider-quota-stack" className="divide-y divide-border">
      {credentials.isPending ? (
        <p className="py-3 text-sm text-muted-foreground">
          <Trans>Loading</Trans>
        </p>
      ) : null}
      {credentials.isError ? (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          <Trans>Could not load usage</Trans>
        </p>
      ) : null}
      {credentials.isSuccess && !connected.length ? (
        <p className="py-3 text-sm text-muted-foreground">
          <Trans>No connected providers</Trans>
        </p>
      ) : null}
      {connected.map((credential) => (
        <div
          key={credential.id}
          data-testid={`provider-quota-${credential.id}`}
          className={`${compact ? "py-3" : "py-4"} first:pt-0 last:pb-0`}
        >
          <ConnectionQuota
            credentialId={credential.id}
            label={credential.label.trim() || credential.provider}
            compact={compact}
          />
        </div>
      ))}
    </div>
  );
}
