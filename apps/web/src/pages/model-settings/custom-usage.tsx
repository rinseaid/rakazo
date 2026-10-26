import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

export function CustomUsage({ credentialId }: { credentialId: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const client = useQueryClient();
  const config = useQuery({
    ...queries.models.customUsage.queryOptions({ input: { credentialId } }),
    retry: false,
  });
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [tokenChanged, setTokenChanged] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    if (config.data) setEndpoint(config.data.endpoint ?? "");
  }, [config.data]);
  return (
    <details className="mt-4 space-y-3" data-testid="custom-usage">
      <summary className="cursor-pointer text-sm">
        <Trans>Custom usage endpoint</Trans>
      </summary>
      <p className="text-xs text-muted-foreground">
        <Trans>Return JSON with named windows and percent used.</Trans>
      </p>
      <code className="block break-all text-xs">
        {'{"windows":[{"id":"daily","usedPercent":35}]}'}
      </code>
      <label htmlFor={`${id}-url`} className="block text-sm">
        <Trans>Usage endpoint URL</Trans>
      </label>
      <Input
        id={`${id}-url`}
        type="url"
        value={endpoint}
        onChange={(event) => setEndpoint(event.target.value)}
        placeholder="https://example.com/usage"
      />
      <label htmlFor={`${id}-token`} className="block text-sm">
        <Trans>Usage endpoint token (optional)</Trans>
      </label>
      <Input
        id={`${id}-token`}
        type="password"
        value={token}
        onChange={(event) => {
          setToken(event.target.value);
          setTokenChanged(true);
          setMessage(null);
        }}
        autoComplete="off"
      />
      {config.data?.hasToken ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setToken("");
            setTokenChanged(true);
            setMessage(t`Token will be removed when saved`);
          }}
        >
          <Trans>Remove saved token</Trans>
        </Button>
      ) : null}
      {config.isError ? (
        <p role="alert" className="text-sm">
          <Trans>Could not load usage</Trans>
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        disabled={pending || !config.isSuccess}
        onClick={async () => {
          setPending(true);
          setMessage(null);
          try {
            await rpc.models.setCustomUsage({
              credentialId,
              endpoint: endpoint.trim() || null,
              ...(tokenChanged ? { token } : {}),
            });
            await config.refetch();
            await Promise.all([
              client.invalidateQueries({ queryKey: queries.models.credentials.queryKey({}) }),
              client.invalidateQueries({
                queryKey: queries.models.quota.queryKey({ input: { credentialId } }),
              }),
            ]);
            setToken("");
            setTokenChanged(false);
            setMessage(t`Saved`);
          } catch (error) {
            setMessage(errorText(error, t`Could not save usage endpoint`));
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
