import { useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import type { SettingsTarget } from "../lib/settings-target";
import { settingsRpc } from "../lib/settings-target";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function CustomUsage({
  credentialId,
  target,
}: {
  credentialId: string;
  target: SettingsTarget;
}) {
  const { t } = useI18n();
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const [expanded, setExpanded] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [tokenChanged, setTokenChanged] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc<{ endpoint: string | null; hasToken: boolean }>("models/customUsage", { credentialId })
      .then((value) => {
        if (!cancelled) {
          setEndpoint(value.endpoint ?? "");
          setHasToken(value.hasToken);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setNotice(t("Could not load usage"));
      });
    return () => {
      cancelled = true;
    };
  }, [credentialId, rpc, t]);
  return (
    <SettingsGroup footer={notice ?? undefined}>
      <SettingsRow
        title={t("Custom usage endpoint")}
        chevron={expanded ? "down" : "right"}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <View style={{ padding: 14, gap: 12 }}>
          <Text style={{ color: native.secondaryLabel }}>
            {t("Return JSON with named windows and percent used.")}
          </Text>
          <Text selectable style={{ color: native.secondaryLabel }}>
            {'{"windows":[{"id":"daily","usedPercent":35}]}'}
          </Text>
          <TextInput
            accessibilityLabel={t("Usage endpoint URL")}
            placeholder="https://example.com/usage"
            placeholderTextColor={native.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            value={endpoint}
            onChangeText={setEndpoint}
            style={{ color: native.label }}
          />
          <TextInput
            accessibilityLabel={t("Usage endpoint token (optional)")}
            placeholder={t("Usage endpoint token (optional)")}
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            value={token}
            onChangeText={(value) => {
              setToken(value);
              setTokenChanged(true);
            }}
            style={{ color: native.label }}
          />
        </View>
      ) : null}
      {expanded && hasToken ? (
        <SettingsRow
          title={t("Remove saved token")}
          onPress={() => {
            setToken("");
            setTokenChanged(true);
            setHasToken(false);
            setNotice(t("Token will be removed when saved"));
          }}
        />
      ) : null}
      {expanded ? (
        <SettingsRow
          title={t("Save")}
          disabled={pending || !loaded}
          onPress={async () => {
            setPending(true);
            setNotice(null);
            try {
              const result = await rpc<{ endpoint: string | null; hasToken: boolean }>(
                "models/setCustomUsage",
                {
                  credentialId,
                  endpoint: endpoint.trim() || null,
                  ...(tokenChanged ? { token } : {}),
                },
              );
              setEndpoint(result.endpoint ?? "");
              setHasToken(result.hasToken);
              setToken("");
              setTokenChanged(false);
              setNotice(t("Saved"));
            } catch (error) {
              setNotice(errorText(error, t("Could not save usage endpoint")));
            } finally {
              setPending(false);
            }
          }}
        />
      ) : null}
    </SettingsGroup>
  );
}
