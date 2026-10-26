import { Trans } from "@lingui/react/macro";
import { connectionUsageGroups, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { providerDisplayName } from "../../lib/localized-provider-hint";
import { useSpaceQueries } from "../../lib/query";
import { ConnectionQuota } from "./connection-quota";

export function ProviderQuotaStack({ compact = false }: { compact?: boolean }) {
  const queries = useSpaceQueries();
  const credentials = useQuery({ ...queries.models.credentials.queryOptions({}), retry: false });
  const catalog = useQuery({ ...queries.models.list.queryOptions({}), retry: false });
  const groups = connectionUsageGroups(credentials.data ?? []);
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
      {credentials.isSuccess && !groups.length ? (
        <p className="py-3 text-sm text-muted-foreground">
          <Trans>No connected providers</Trans>
        </p>
      ) : null}
      {groups.map(({ credential, gateways }) => {
        const gatewayNames = gateways.map((gateway) => gateway.label).join(", ");
        const providerName = providerDisplayName(
          credential.provider,
          catalog.data?.find((entry) => entry.provider === credential.provider)?.providerName ??
            credential.provider,
          credential.authKind,
        );
        const label =
          credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
            ? credential.label.trim() || providerName
            : providerName;
        const accountLabel =
          credential.label.trim() && credential.label.trim() !== label
            ? credential.label.trim()
            : undefined;
        return (
          <div
            key={credential.id}
            data-testid={`provider-quota-${credential.id}`}
            className={`${compact ? "py-3" : "py-4"} first:pt-0 last:pb-0`}
          >
            {gateways.length ? (
              <p
                className="mb-2 break-words text-xs text-muted-foreground"
                data-testid="usage-gateway-links"
              >
                <Trans>Linked to {gatewayNames}</Trans>
              </p>
            ) : null}
            <ConnectionQuota
              credentialId={credential.id}
              label={label}
              accountLabel={accountLabel}
              compact={compact}
            />
          </div>
        );
      })}
    </div>
  );
}
