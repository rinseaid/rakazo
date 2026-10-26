import type { ModelCredential } from "@rakazo/contracts";
import { usageAccountCandidates } from "@rakazo/contracts";
import { useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { SettingsTarget } from "../lib/settings-target";
import { settingsRpc } from "../lib/settings-target";
import { errorText } from "../lib/user-error";
import { ConnectionQuota } from "./connection-quota";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-group";

export function UsageAccounts({
  credential,
  credentials,
  target,
  labelFor,
  onSaved,
}: {
  credential: ModelCredential;
  credentials: ModelCredential[];
  target: SettingsTarget;
  labelFor: (credential: ModelCredential) => string;
  onSaved: (usageAccountIds: string[]) => void;
}) {
  const { t } = useI18n();
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(credential.usageAccountIds ?? []);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const candidates = usageAccountCandidates(credentials, credential.id);
  return (
    <>
      <SettingsGroup footer={notice ?? undefined}>
        <SettingsRow
          title={t("Usage accounts")}
          chevron={expanded ? "down" : "right"}
          onPress={() => setExpanded((value) => !value)}
        />
        {expanded ? (
          <>
            <SettingsRow
              title={t("Show upstream usage without changing this connection's routing.")}
            />
            {!candidates.length ? (
              <SettingsRow title={t("Connect an upstream account to show its usage.")} />
            ) : null}
            {candidates.map((account) => (
              <SettingsSwitch
                key={account.id}
                label={labelFor(account)}
                value={selected.includes(account.id)}
                disabled={pending}
                onChange={(checked) => {
                  setSelected((current) =>
                    checked ? [...current, account.id] : current.filter((id) => id !== account.id),
                  );
                  setNotice(null);
                }}
              />
            ))}
            <SettingsRow
              title={t("Save")}
              disabled={
                pending ||
                selected.slice().sort().join() ===
                  (credential.usageAccountIds ?? []).slice().sort().join()
              }
              onPress={async () => {
                setPending(true);
                setNotice(null);
                try {
                  const result = await rpc<{ usageAccountIds: string[] }>(
                    "models/setUsageAccounts",
                    { credentialId: credential.id, usageAccountIds: selected },
                  );
                  onSaved(result.usageAccountIds);
                  setNotice(t("Saved"));
                } catch (error) {
                  setNotice(errorText(error, t("Could not save usage accounts")));
                } finally {
                  setPending(false);
                }
              }}
            />
          </>
        ) : null}
      </SettingsGroup>
      {(credential.usageAccountIds ?? []).map((id) => {
        const account = credentials.find((entry) => entry.id === id);
        return account ? (
          <ConnectionQuota
            key={id}
            credentialId={id}
            target={target}
            label={labelFor(account)}
            readOnly
          />
        ) : null;
      })}
    </>
  );
}
