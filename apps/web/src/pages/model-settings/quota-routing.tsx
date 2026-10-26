import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelQuotaPolicy } from "@rakazo/contracts";
import { ModelQuotaPolicySchema } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

export function QuotaRouting({ credentialId }: { credentialId: string }) {
  const queries = useSpaceQueries();
  const policy = useQuery({
    ...queries.models.quotaPolicy.queryOptions({ input: { credentialId } }),
    retry: false,
  });
  if (policy.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        <Trans>Could not load routing settings</Trans>
      </p>
    );
  if (!policy.data)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading</Trans>
      </p>
    );
  return <QuotaRoutingForm credentialId={credentialId} initial={policy.data} />;
}

function QuotaRoutingForm({
  credentialId,
  initial,
}: {
  credentialId: string;
  initial: ModelQuotaPolicy;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const client = useQueryClient();
  const id = useId();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [reserve, setReserve] = useState(String(initial.reservePercent));
  const [request, setRequest] = useState(
    initial.requestPercent === null ? "" : String(initial.requestPercent),
  );
  const [uncertainty, setUncertainty] = useState(String(initial.uncertaintyPercent));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const parsed = ModelQuotaPolicySchema.safeParse({
    enabled,
    reservePercent: Number(reserve),
    requestPercent: request.trim() ? Number(request) : null,
    uncertaintyPercent: Number(uncertainty),
  });
  return (
    <form
      className="space-y-3 rounded-lg border border-border p-3"
      onChange={() => setSaved(false)}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!parsed.success || pending) return;
        setPending(true);
        setError(null);
        try {
          const result = await rpc.models.setQuotaPolicy({ credentialId, policy: parsed.data });
          client.setQueryData(
            queries.models.quotaPolicy.queryKey({ input: { credentialId } }),
            result,
          );
          setSaved(true);
        } catch (failure) {
          setError(errorText(failure, t`Could not save routing settings`));
        } finally {
          setPending(false);
        }
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          disabled={pending}
        />
        <Trans>Quota-aware routing</Trans>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label htmlFor={`${id}-reserve`} className="space-y-1 text-sm">
          <span>
            <Trans>Reserve (%)</Trans>
          </span>
          <Input
            id={`${id}-reserve`}
            type="number"
            min={0}
            max={99}
            step="0.01"
            value={reserve}
            onChange={(event) => setReserve(event.target.value)}
            disabled={pending}
          />
        </label>
        <label htmlFor={`${id}-request`} className="space-y-1 text-sm">
          <span>
            <Trans>Request estimate (%)</Trans>
          </span>
          <Input
            id={`${id}-request`}
            type="number"
            min="0.001"
            max={100}
            step="0.001"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            disabled={pending}
          />
        </label>
        <label htmlFor={`${id}-uncertainty`} className="space-y-1 text-sm">
          <span>
            <Trans>Uncertainty (%)</Trans>
          </span>
          <Input
            id={`${id}-uncertainty`}
            type="number"
            min="0.001"
            max={100}
            step="0.001"
            value={uncertainty}
            onChange={(event) => setUncertainty(event.target.value)}
            disabled={pending}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>Estimates remain reserved until the applicable window resets.</Trans>
      </p>
      {enabled && !request.trim() ? (
        <p className="text-sm text-warning">
          <Trans>Set a request estimate before enabling quota routing</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Saved</Trans>
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={pending || !parsed.success}>
        <Trans>Save</Trans>
      </Button>
    </form>
  );
}
