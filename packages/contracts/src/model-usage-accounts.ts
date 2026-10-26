import type { ModelCredential } from "./domain.js";
import { isCommandCodeBaseUrl, isOpenCodeGoBaseUrl } from "./openai-compatible-ui.js";

/** Only direct connections with an existing usage reader can supply an upstream meter. */
export function supportsUsageAccount(credential: ModelCredential): boolean {
  if (credential.usageAccountIds?.length) return false;
  if (["openai-codex", "anthropic"].includes(credential.provider))
    return credential.authKind === "oauth";
  if (!credential.hasKey) return false;
  return (
    credential.provider === "opencode-go" ||
    (credential.provider === "openai-compatible" &&
      (isCommandCodeBaseUrl(credential.baseUrl) || isOpenCodeGoBaseUrl(credential.baseUrl)))
  );
}

export function usageAccountCandidates(credentials: ModelCredential[], credentialId: string) {
  return credentials.filter((entry) => entry.id !== credentialId && supportsUsageAccount(entry));
}

/** One card per actual connection, even when several gateways share its allowance. */
export function connectionUsageGroups(credentials: ModelCredential[]) {
  const ids = new Set(credentials.map((entry) => entry.id));
  const gateways = credentials.filter(
    (entry) =>
      entry.provider === "openai-compatible" && entry.usageAccountIds?.some((id) => ids.has(id)),
  );
  const gatewayIds = new Set(gateways.map((entry) => entry.id));
  const linkedIds = new Set(gateways.flatMap((entry) => entry.usageAccountIds ?? []));
  return credentials
    .filter(
      (entry) =>
        !gatewayIds.has(entry.id) &&
        (entry.hasKey || entry.authKind === "oauth" || linkedIds.has(entry.id)),
    )
    .map((credential) => ({
      credential,
      gateways: gateways.filter((entry) => entry.usageAccountIds?.includes(credential.id)),
    }));
}
