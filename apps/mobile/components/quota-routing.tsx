import type { ModelQuotaPolicy } from "@rakazo/contracts";
import { ModelQuotaPolicySchema } from "@rakazo/contracts";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, TextInput } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
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
  const styles = useThemedStyles(() =>
    StyleSheet.create({
      number: { color: native.label, fontSize: 16, minWidth: 72, textAlign: "right" },
    }),
  );
  const [enabled, setEnabled] = useState(initial.enabled);
  const [reserve, setReserve] = useState(String(initial.reservePercent));
  const [request, setRequest] = useState(
    initial.requestPercent === null ? "" : String(initial.requestPercent),
  );
  const [uncertainty, setUncertainty] = useState(String(initial.uncertaintyPercent));
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const parsed = ModelQuotaPolicySchema.safeParse({
    enabled,
    reservePercent: Number(reserve),
    requestPercent: request.trim() ? Number(request) : null,
    uncertaintyPercent: Number(uncertainty),
  });
  const field = (label: string, value: string, change: (next: string) => void) => (
    <SettingsRow
      title={label}
      trailing={
        <TextInput
          accessibilityLabel={label}
          inputMode="decimal"
          value={value}
          editable={!pending}
          onChangeText={(next) => {
            change(next);
            setNotice(null);
          }}
          style={styles.number}
        />
      }
    />
  );
  return (
    <SettingsGroup
      label={t("Routing")}
      footer={notice ?? t("Estimates remain reserved until the applicable window resets.")}
    >
      <SettingsRow
        title={t("Quota-aware routing")}
        trailing={
          <NativeSwitch
            accessibilityLabel={t("Quota-aware routing")}
            value={enabled}
            disabled={pending}
            onValueChange={(next) => {
              setEnabled(next);
              setNotice(null);
            }}
          />
        }
      />
      {field(t("Reserve (%)"), reserve, setReserve)}
      {field(t("Request estimate (%)"), request, setRequest)}
      {field(t("Uncertainty (%)"), uncertainty, setUncertainty)}
      <SettingsRow
        title={t("Save")}
        disabled={pending || !parsed.success}
        onPress={async () => {
          if (!parsed.success || pending) return;
          setPending(true);
          setNotice(null);
          try {
            await rpc("models/setQuotaPolicy", { credentialId, policy: parsed.data });
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
