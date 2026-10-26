// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionQuota } from "./connection-quota";

const read = vi.hoisted(() => vi.fn());
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    models: {
      quota: {
        queryOptions: ({ input }: { input: { credentialId: string } }) => ({
          queryKey: ["quota", input.credentialId],
          queryFn: read,
        }),
      },
    },
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick: () => void;
    disabled: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((value, part, index) => value + part + (values[index] ?? ""), ""),
  }),
}));

const observation = {
  credentialId: "connection-a",
  status: "fresh",
  observedAt: "2030-03-17T12:00:00Z",
  checkedAt: "2030-03-17T12:00:00Z",
  identityVerified: true,
  windows: [{ id: "seven_day", usedPercent: 91, resetsAt: "2030-03-20T12:00:00Z", modelIds: null }],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => {
    cleanup();
  });
  vi.resetAllMocks();
});
async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionQuota credentialId="connection-a" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return host;
}

it("shows the real remaining percentage and provider reset", async () => {
  read.mockResolvedValue(observation);
  const host = await mount();
  expect(host.textContent).toContain("9% remaining");
  expect(host.querySelector("meter")?.value).toBe(9);
  expect(host.querySelector("time")?.dateTime).toBe(observation.windows[0]?.resetsAt);
});
it("refreshes the observation from the server", async () => {
  read.mockResolvedValueOnce(observation).mockResolvedValue({
    ...observation,
    windows: [{ ...observation.windows[0], usedPercent: 100 }],
  });
  const host = await mount();
  await act(async () => {
    host.querySelector("button")?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(host.textContent).toContain("0% remaining");
  expect(read).toHaveBeenCalledTimes(2);
});
it("labels stale values and preserves their observation time", async () => {
  read.mockResolvedValue({ ...observation, status: "stale" });
  const host = await mount();
  expect(host.textContent).toContain("Last known usage");
  expect(host.textContent).toContain("9% remaining");
  expect(host.querySelectorAll("time")[1]?.dateTime).toBe(observation.observedAt);
});
it("does not fabricate remaining quota when the reader fails", async () => {
  read.mockRejectedValue(new Error("reader unavailable"));
  const host = await mount();
  expect(host.textContent).toContain("Quota unavailable");
  expect(host.querySelector("meter")).toBeNull();
});
