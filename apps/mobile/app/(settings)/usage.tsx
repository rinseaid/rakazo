import type { UsageSummary } from "@rakazo/contracts";
import { connectionDisplayName, connectionUsageGroups } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionQuota } from "../../components/connection-quota";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import type { MobileModel, MobileModelCredential } from "../../lib/api";
import { rpc } from "../../lib/api";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { native } from "../../lib/native";
import { ACCOUNT_SETTINGS } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";

export default function Usage() {
  const { t, locale } = useI18n();
  const sideInsets = useSideInsets();
  const [credentials, setCredentials] = useState<MobileModelCredential[] | null>(null);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [failed, setFailed] = useState(false);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setFailed(false);
      void rpc<UsageSummary>("usage/summary")
        .then((value) => {
          if (active) setSummary(value);
        })
        .catch(() => undefined);
      void Promise.all([
        rpc<MobileModelCredential[]>("models/credentials"),
        rpc<MobileModel[]>("models/list").catch(() => []),
      ])
        .then(([connections, models]) => {
          if (active) {
            setCredentials(connections);
            setCatalog(models);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
      return () => {
        active = false;
      };
    }, []),
  );
  const groups = connectionUsageGroups(credentials ?? []);
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {summary ? (
          <SettingsGroup>
            <SettingsRow
              title={t("Usage")}
              detail={t("{runs} runs, {tokens} tokens", {
                runs: new Intl.NumberFormat(dateLocaleForUi(locale)).format(summary.runs),
                tokens:
                  summary.totalTokens == null
                    ? "—"
                    : new Intl.NumberFormat(dateLocaleForUi(locale)).format(summary.totalTokens),
              })}
            />
          </SettingsGroup>
        ) : null}
        {failed ? (
          <SettingsGroup>
            <SettingsRow title={t("Could not load usage")} />
          </SettingsGroup>
        ) : null}
        {!failed && !credentials ? (
          <SettingsGroup>
            <SettingsRow title={t("Loading")} />
          </SettingsGroup>
        ) : null}
        {!failed && credentials && groups.length === 0 ? (
          <SettingsGroup>
            <SettingsRow title={t("No connected providers")} />
          </SettingsGroup>
        ) : null}
        {groups.map(({ credential }) => {
          const name =
            credential.provider === "openai-codex"
              ? "Codex"
              : credential.provider === "anthropic" && credential.authKind === "oauth"
                ? "Claude subscription"
                : (catalog.find((entry) => entry.provider === credential.provider)?.providerName ??
                  credential.provider);
          return (
            <ConnectionQuota
              key={credential.id}
              credentialId={credential.id}
              target={ACCOUNT_SETTINGS}
              label={connectionDisplayName(credential, name)}
              readOnly
            />
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: native.groupedPage },
  content: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 28,
  },
});
