import type { ModelQuota } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { SettingsTarget } from "../lib/settings-target";
import { settingsRpc } from "../lib/settings-target";
import { QuotaRouting } from "./quota-routing";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function ConnectionQuota({
  credentialId,
  target,
  label,
  readOnly = false,
}: {
  credentialId: string;
  target: SettingsTarget;
  label?: string;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const [quota, setQuota] = useState<ModelQuota | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [routing, setRouting] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let canceled = false;
      const load = async () => {
        setPending(true);
        try {
          const result = await rpc<ModelQuota>("models/quota", { credentialId });
          if (!canceled) setQuota(result);
        } catch {
          if (!canceled) setQuota((current) => (current ? { ...current, status: "stale" } : null));
        } finally {
          if (!canceled) setPending(false);
        }
      };
      void load();
      const timer = setInterval(() => void load(), 60_000);
      return () => {
        canceled = true;
        clearInterval(timer);
      };
    }, [credentialId, rpc, refresh]),
  );
  if (quota?.status === "unsupported") return null;
  return (
    <>
      <SettingsGroup
        label={label ?? t("Quota")}
        footer={
          quota?.observedAt
            ? `${t("Updated")} ${new Date(quota.observedAt).toLocaleString()}`
            : undefined
        }
      >
        {quota?.status === "stale" ? <SettingsRow title={t("Last known usage")} /> : null}
        {!quota || quota.status === "unavailable" ? (
          <SettingsRow title={pending ? t("Loading") : t("Quota unavailable")} />
        ) : null}
        {quota?.windows.map((window) => (
          <SettingsRow
            key={window.id}
            title={
              window.id === "five_hour"
                ? t("Session")
                : window.id === "seven_day"
                  ? t("Weekly")
                  : window.id === "monthly"
                    ? t("Monthly")
                    : window.id === "primary_window" || window.id === "secondary_window"
                      ? t("Allowance")
                      : window.id
            }
            value={t("{remaining}% remaining", {
              remaining: Math.round((100 - window.usedPercent) * 10) / 10,
            })}
            detail={
              window.resetsAt
                ? `${t("Resets")} ${new Date(window.resetsAt).toLocaleString()}`
                : t("Reset unknown")
            }
          />
        ))}
        <SettingsRow
          title={t("Refresh")}
          disabled={pending}
          onPress={() => setRefresh((value) => value + 1)}
        />
        {!readOnly ? (
          <SettingsRow
            title={t("Routing")}
            onPress={() => setRouting((value) => !value)}
            chevron={routing ? "down" : "right"}
          />
        ) : null}
      </SettingsGroup>
      {!readOnly && routing ? <QuotaRouting credentialId={credentialId} target={target} /> : null}
    </>
  );
}
