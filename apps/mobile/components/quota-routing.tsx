import type { ModelQuotaPolicy } from "@rakazo/contracts";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { SettingsTarget } from "../lib/settings-target";
import { settingsRpc } from "../lib/settings-target";
import { NativeSwitch } from "./native-switch";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function QuotaRouting({
  credentialId,
  target,
}: {
  credentialId: string;
  target: SettingsTarget;
}) {
  const { t } = useI18n();
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const [policy, setPolicy] = useState<ModelQuotaPolicy | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let canceled = false;
    void rpc<ModelQuotaPolicy>("models/quotaPolicy", { credentialId }).then(
      (result) => {
        if (!canceled) setPolicy(result);
      },
      () => {
        if (!canceled) setFailed(true);
      },
    );
    return () => {
      canceled = true;
    };
  }, [credentialId, rpc]);
  if (!policy)
    return (
      <SettingsGroup>
        <SettingsRow title={failed ? t("Could not load routing settings") : t("Loading")} />
      </SettingsGroup>
    );
  return <QuotaRoutingEditor credentialId={credentialId} target={target} initial={policy} />;
}

function QuotaRoutingEditor({
  credentialId,
  target,
  initial,
}: {
  credentialId: string;
  target: SettingsTarget;
  initial: ModelQuotaPolicy;
}) {
  const { t } = useI18n();
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SettingsGroup label={t("Routing")} footer={notice ?? undefined}>
      <SettingsRow
        title={t("Skip exhausted accounts")}
        trailing={
          <NativeSwitch
            accessibilityLabel={t("Skip exhausted accounts")}
            value={enabled}
            disabled={pending}
            onValueChange={(next) => {
              setEnabled(next);
              setNotice(null);
            }}
          />
        }
      />
      <SettingsRow
        title={t("Save")}
        disabled={pending}
        onPress={async () => {
          if (pending) return;
          setPending(true);
          setNotice(null);
          try {
            await rpc("models/setQuotaPolicy", { credentialId, policy: { enabled } });
            setNotice(t("Saved"));
          } catch {
            setNotice(t("Could not save routing settings"));
          } finally {
            setPending(false);
          }
        }}
      />
    </SettingsGroup>
  );
}
