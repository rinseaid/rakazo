import { describe, expect, it } from "vitest";
import type { ModelCredential } from "./domain.js";
import {
  connectionUsageGroups,
  supportsUsageAccount,
  usageAccountCandidates,
} from "./model-usage-accounts.js";

const account: ModelCredential = {
  id: "account",
  provider: "opencode-go",
  label: "OpenCode Go",
  hasKey: true,
  authKind: "api_key",
  isDefault: false,
};
const gateway: ModelCredential = {
  id: "gateway",
  provider: "openai-compatible",
  label: "LiteLLM",
  hasKey: true,
  isDefault: false,
  baseUrl: "https://gateway.example.test/v1",
  usageAccountIds: [account.id],
};

describe("usage account selection", () => {
  it("offers direct supported accounts, never itself, gateways or unconfigured providers", () => {
    expect(
      usageAccountCandidates(
        [
          account,
          gateway,
          { ...account, id: "empty", hasKey: false },
          { ...account, id: "unsupported", provider: "openrouter" },
        ],
        gateway.id,
      ),
    ).toEqual([account]);
    expect(
      supportsUsageAccount({
        ...account,
        provider: "openai-codex",
        hasKey: false,
        authKind: "oauth",
      }),
    ).toBe(true);
    expect(supportsUsageAccount({ ...account, provider: "anthropic", authKind: "api_key" })).toBe(
      false,
    );
  });
  it("recognizes manually entered direct provider URLs but never arbitrary gateway URLs", () => {
    for (const baseUrl of [
      "https://opencode.ai/zen/go/v1",
      "https://api.commandcode.ai/provider/v1/",
    ])
      expect(supportsUsageAccount({ ...account, provider: "openai-compatible", baseUrl })).toBe(
        true,
      );
    expect(supportsUsageAccount({ ...gateway, usageAccountIds: [] })).toBe(false);
  });
  it("shows a shared upstream once and names every linked gateway", () => {
    const other = { ...gateway, id: "other", label: "Other gateway", hasKey: false };
    expect(connectionUsageGroups([account, gateway, other])).toEqual([
      { credential: account, gateways: [gateway, other] },
    ]);
  });
  it("removing all links restores the gateway's ordinary direct readout", () => {
    const direct = { ...gateway, usageAccountIds: [] };
    expect(connectionUsageGroups([account, direct])).toHaveLength(2);
  });
  it("keeps a linked account visible when its credentials become unavailable", () => {
    const unavailable = { ...account, hasKey: false };
    expect(connectionUsageGroups([unavailable, gateway])).toEqual([
      { credential: unavailable, gateways: [gateway] },
    ]);
  });
});
