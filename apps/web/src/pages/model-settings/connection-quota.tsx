import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelQuotaWindow } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { QuotaRouting } from "./quota-routing";

/** Quota stays with its connection; opening settings never changes routing. */
export function ConnectionQuota({ credentialId }: { credentialId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [routing, setRouting] = useState(false);
  const quota = useQuery({
    ...queries.models.quota.queryOptions({ input: { credentialId } }),
    refetchInterval: 60_000,
    retry: false,
  });
  const observation = quota.data;
  if (observation?.status === "unsupported") return null;
  return (
    <section aria-label={t`Quota`} className="mb-6 space-y-3" data-testid="connection-quota">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">
          <Trans>Quota</Trans>
        </h4>
        <Button
          variant="ghost"
          size="sm"
          disabled={quota.isFetching}
          onClick={() => void quota.refetch()}
        >
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {quota.isPending ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading</Trans>
        </p>
      ) : null}
      {quota.isError || observation?.status === "unavailable" ? (
        <p className="text-sm text-muted-foreground" role="status">
          <Trans>Quota unavailable</Trans>
        </p>
      ) : null}
      {observation?.status === "stale" ? (
        <p className="text-sm text-warning" role="status">
          <Trans>Last known usage</Trans>
        </p>
      ) : null}
      {observation?.windows.map((window) => (
        <QuotaWindow key={window.id} window={window} />
      ))}
      {observation?.observedAt ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Updated</Trans>{" "}
          <time dateTime={observation.observedAt}>
            {new Date(observation.observedAt).toLocaleString()}
          </time>
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setRouting((value) => !value)}
        aria-expanded={routing}
      >
        <Trans>Routing</Trans>
      </Button>
      {routing ? <QuotaRouting credentialId={credentialId} /> : null}
    </section>
  );
}

function QuotaWindow({ window }: { window: ModelQuotaWindow }) {
  const { t } = useLingui();
  const remaining = Math.round((100 - window.usedPercent) * 10) / 10;
  const label =
    window.id === "five_hour" ? t`Session` : window.id === "seven_day" ? t`Weekly` : t`Allowance`;
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-3 text-sm">
        <span>{label}</span>
        <span
          className={remaining === 0 ? "text-destructive" : "text-foreground"}
        >{t`${remaining}% remaining`}</span>
      </div>
      <meter
        min={0}
        max={100}
        value={remaining}
        aria-label={label}
        className="h-2 w-full appearance-none [&::-moz-meter-bar]:bg-foreground [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-muted [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-foreground [&::-webkit-meter-optimum-value]:bg-none"
      />
      <p className="text-xs text-muted-foreground">
        {window.resetsAt ? (
          <>
            <Trans>Resets</Trans>{" "}
            <time dateTime={window.resetsAt}>{new Date(window.resetsAt).toLocaleString()}</time>
          </>
        ) : (
          <Trans>Reset unknown</Trans>
        )}
      </p>
    </div>
  );
}
