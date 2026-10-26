// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProviderQuotaStack } from "./provider-quota-stack";

const read = vi.hoisted(() => vi.fn());
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    models: { credentials: { queryOptions: () => ({ queryKey: ["credentials"], queryFn: read }) } },
  }),
}));
vi.mock("./connection-quota", () => ({
  ConnectionQuota: ({ credentialId, label }: { credentialId: string; label: string }) => (
    <section data-credential-id={credentialId}>{label}</section>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

it("includes native OAuth connections without an API key and hides disconnected keys", async () => {
  read.mockResolvedValue([
    { id: "go", provider: "opencode-go", label: "Go", hasKey: true, authKind: "api_key" },
    { id: "codex", provider: "openai-codex", label: "Codex", hasKey: false, authKind: "oauth" },
    { id: "claude", provider: "anthropic", label: "Claude", hasKey: false, authKind: "oauth" },
    { id: "empty", provider: "openai", label: "Disconnected", hasKey: false },
  ]);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProviderQuotaStack />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect([...host.querySelectorAll("[data-credential-id]")].map((node) => node.textContent)).toEqual([
      "Go",
      "Codex",
      "Claude",
    ]);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
    vi.resetAllMocks();
  }
});
