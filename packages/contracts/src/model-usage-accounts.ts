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

/** Display every connected provider independently. Legacy links no longer alter Usage. */
export function connectionUsageGroups(credentials: ModelCredential[]) {
  return credentials
    .filter((entry) => entry.hasKey || entry.authKind === "oauth" || entry.hasCustomUsage)
    .map((credential) => ({ credential, gateways: [] as ModelCredential[] }));
}
