import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelQuotaPolicy } from "@rakazo/contracts";
import { Button, Checkbox } from "@rakazo/ui-web";
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = { enabled };
  return (
    <form
      className="space-y-3 rounded-lg border border-border p-3"
      onChange={() => setSaved(false)}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError(null);
        try {
          const result = await rpc.models.setQuotaPolicy({ credentialId, policy });
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
      <label htmlFor={`${id}-enabled`} className="flex items-center gap-2 text-sm">
        <Checkbox
          id={`${id}-enabled`}
          checked={enabled}
          onCheckedChange={(checked) => {
            setEnabled(checked);
            setSaved(false);
          }}
          disabled={pending}
        />
        <Trans>Skip exhausted accounts</Trans>
      </label>
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
      <Button type="submit" size="sm" disabled={pending}>
        <Trans>Save</Trans>
      </Button>
    </form>
  );
}
