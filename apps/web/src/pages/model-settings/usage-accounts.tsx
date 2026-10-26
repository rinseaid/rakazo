import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCredential } from "@rakazo/contracts";
import { usageAccountCandidates } from "@rakazo/contracts";
import { Button, Checkbox } from "@rakazo/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

export function UsageAccounts({
  credential,
  credentials,
  labelFor,
}: {
  credential: ModelCredential;
  credentials: ModelCredential[];
  labelFor: (credential: ModelCredential) => string;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const client = useQueryClient();
  const inputId = useId();
  const [selected, setSelected] = useState(credential.usageAccountIds ?? []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const candidates = usageAccountCandidates(credentials, credential.id);
  const dirty =
    selected.slice().sort().join() !== (credential.usageAccountIds ?? []).slice().sort().join();
  return (
    <details className="mt-4 space-y-3" data-testid="usage-accounts">
      <summary className="cursor-pointer text-sm">
        <Trans>Usage accounts</Trans>
      </summary>
      <p className="text-xs text-muted-foreground">
        <Trans>Show upstream usage without changing this connection's routing.</Trans>
      </p>
      {!candidates.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Connect an upstream account to show its usage.</Trans>
        </p>
      ) : null}
      {candidates.map((account) => (
        <label
          key={account.id}
          htmlFor={`${inputId}-${account.id}`}
          className="flex items-center gap-2 text-sm"
        >
          <Checkbox
            id={`${inputId}-${account.id}`}
            checked={selected.includes(account.id)}
            disabled={pending}
            onCheckedChange={(checked) => {
              setSelected((current) =>
                checked ? [...current, account.id] : current.filter((id) => id !== account.id),
              );
              setSaved(false);
            }}
          />
          <span className="min-w-0 break-words">{labelFor(account)}</span>
        </label>
      ))}
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
      <Button
        type="button"
        size="sm"
        disabled={pending || !dirty}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const result = await rpc.models.setUsageAccounts({
              credentialId: credential.id,
              usageAccountIds: selected,
            });
            client.setQueryData<ModelCredential[]>(
              queries.models.credentials.queryKey({}),
              (current) =>
                (current ?? credentials).map((entry) =>
                  entry.id === credential.id
                    ? { ...entry, usageAccountIds: result.usageAccountIds }
                    : entry,
                ),
            );
            setSaved(true);
          } catch (failure) {
            setError(errorText(failure, t`Could not save usage accounts`));
          } finally {
            setPending(false);
          }
        }}
      >
        <Trans>Save</Trans>
      </Button>
    </details>
  );
}
