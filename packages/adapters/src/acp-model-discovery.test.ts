import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { discoverAcpModels, readAcpModels } from "./acp-model-discovery.js";
import type { AcpSessionHost, AcpTransport } from "./acp-session.js";

const choices = [{ value: "fixture-a", name: "Fixture A", description: "Test model" }];
const config = {
  id: "model-selector",
  name: "Model",
  category: "model",
  type: "select" as const,
  currentValue: "fixture-a",
  options: choices,
};
const modern = {
  sessionId: "fixture-session",
  configOptions: [config],
} satisfies NewSessionResponse;
const legacy = {
  models: {
    currentModelId: "fixture-b",
    availableModels: [{ modelId: "fixture-b", name: "Fixture B" }],
  },
};

describe("ACP model metadata", () => {
  it("uses only authoritative modern identity and display metadata", () => {
    expect(readAcpModels({ ...modern, ...legacy })).toEqual({
      models: [{ id: "fixture-a", name: "Fixture A", description: "Test model" }],
      currentModelId: "fixture-a",
      selection: { method: "session/set_config_option", configId: "model-selector" },
    });
  });

  it("flattens standard groups without deriving IDs from labels", () => {
    expect(
      readAcpModels({
        configOptions: [
          { ...config, options: [{ group: "group-a", name: "Group", options: choices }] },
        ],
      }).models,
    ).toEqual([{ id: "fixture-a", name: "Fixture A", description: "Test model" }]);
  });

  it("returns only advertised reasoning levels for the selected model", () => {
    const discovery = readAcpModels({
      ...modern,
      configOptions: [
        config,
        {
          id: "thought-level",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "vendor-default", name: "Provider default" },
          ],
        },
      ],
    });
    expect(discovery.models).toEqual([
      {
        id: "fixture-a",
        name: "Fixture A",
        description: "Test model",
        thinkingLevels: ["low", "medium", "high"],
      },
    ]);
  });

  it("supports legacy models when no semantic model selector exists", () => {
    expect(readAcpModels({ ...legacy, configOptions: [{ category: "thought_level" }] })).toEqual({
      models: [{ id: "fixture-b", name: "Fixture B" }],
      currentModelId: "fixture-b",
      selection: { method: "session/set_model" },
    });
  });

  it("retains Anthropic and OpenAI model IDs advertised by the native account", () => {
    expect(
      readAcpModels({
        configOptions: [
          {
            ...config,
            currentValue: "claude-sonnet-4-5",
            options: [
              { value: "claude-sonnet-4-5", name: "Claude Sonnet" },
              { value: "gpt-5.6-sol", name: "GPT" },
            ],
          },
        ],
      }).models.map((model) => model.id),
    ).toEqual(["claude-sonnet-4-5", "gpt-5.6-sol"]);
  });

  it("does not guess category from an option ID or invent a missing catalog", () => {
    expect(readAcpModels({ configOptions: [{ ...config, category: undefined }] })).toEqual({
      models: [],
    });
    expect(readAcpModels({ models: null, configOptions: null })).toEqual({ models: [] });
  });

  it.each([
    { ...config, options: [...choices, ...choices] },
    { ...config, options: [{ group: "g", name: "G", options: [...choices, ...choices] }] },
    { ...config, options: [{ value: "", name: "Invalid" }] },
    { ...config, options: [{ value: "fixture-a", name: " " }] },
    { ...config, options: [{ value: "fixture-a", name: "A", description: 2 }] },
    {
      ...config,
      options: [{ group: "g", name: "G", options: [{ group: "nested", options: choices }] }],
    },
    { ...config, options: [...choices, { group: "g", name: "G", options: [] }] },
    { ...config, options: [] },
    { ...config, currentValue: "not-advertised" },
    { ...config, id: "" },
    { ...config, type: "boolean" },
  ])("rejects invalid/duplicate choices rather than falling back to legacy", (invalid) => {
    expect(() => readAcpModels({ ...legacy, configOptions: [invalid] })).toThrow();
  });

  it("rejects ambiguous model selectors and malformed legacy state", () => {
    for (const value of [
      { configOptions: [config, config] },
      { configOptions: {} },
      null,
      {
        models: {
          ...legacy.models,
          availableModels: [...legacy.models.availableModels, ...legacy.models.availableModels],
        },
      },
      { models: { ...legacy.models, currentModelId: "absent" } },
      { models: { availableModels: [] } },
    ])
      expect(() => readAcpModels(value)).toThrow();
  });
});

function fixture(session: unknown = modern) {
  let handlers!: Parameters<AcpSessionHost["connect"]>[0];
  const transport: AcpTransport = {
    request: vi.fn(async (method) => (method === "initialize" ? { protocolVersion: 1 } : session)),
    notify: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const host: AcpSessionHost = {
    connect: vi.fn(async (value) => {
      handlers = value;
      return transport;
    }),
  };
  return { host, transport, handlers: () => handlers };
}

describe("scoped ACP model discovery", () => {
  it("creates no prompt or tools, denies permissions, and closes before returning", async () => {
    const f = fixture();
    expect(await discoverAcpModels(f.host, { cwd: "/fixture" })).toEqual(readAcpModels(modern));
    expect(vi.mocked(f.transport.request).mock.calls.map(([method]) => method)).toEqual([
      "initialize",
      "session/new",
    ]);
    expect(f.transport.request).toHaveBeenLastCalledWith(
      "session/new",
      { cwd: "/fixture", mcpServers: [] },
      undefined,
    );
    expect(
      await f.handlers().permission({ sessionId: "fixture-session", toolCall: {}, options: [] }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });

  it("closes on invalid metadata, unsupported protocol, and transport errors", async () => {
    for (const failure of ["metadata", "protocol", "transport"]) {
      const f = fixture({ sessionId: "s", configOptions: [config, config] });
      if (failure === "protocol")
        vi.mocked(f.transport.request).mockResolvedValue({ protocolVersion: 99 });
      if (failure === "transport")
        vi.mocked(f.transport.request).mockRejectedValue(new Error("offline"));
      await expect(discoverAcpModels(f.host, { cwd: "/fixture" })).rejects.toThrow();
      expect(f.transport.close).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects a missing session identity and unconfirmed cleanup", async () => {
    const missing = fixture({ ...modern, sessionId: "" });
    await expect(discoverAcpModels(missing.host, { cwd: "/fixture" })).rejects.toThrow();
    expect(missing.transport.close).toHaveBeenCalledTimes(1);
    const cleanup = fixture();
    vi.mocked(cleanup.transport.close).mockRejectedValue(new Error("cleanup incomplete"));
    await expect(discoverAcpModels(cleanup.host, { cwd: "/fixture" })).rejects.toThrow(
      "cleanup incomplete",
    );
  });

  it("closes when an in-flight discovery request is cancelled", async () => {
    const f = fixture();
    const controller = new AbortController();
    vi.mocked(f.transport.request).mockImplementation(async (_method, _params, signal) => {
      controller.abort();
      signal?.throwIfAborted();
    });
    await expect(
      discoverAcpModels(f.host, { cwd: "/fixture" }, controller.signal),
    ).rejects.toThrow();
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });

  it("does not open an aborted host and closes a connection arriving after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverAcpModels(f.host, { cwd: "/fixture" }, controller.signal),
    ).rejects.toThrow();
    expect(f.host.connect).not.toHaveBeenCalled();
    const late = new AbortController();
    vi.mocked(f.host.connect).mockImplementation(async () => {
      late.abort();
      return f.transport;
    });
    await expect(discoverAcpModels(f.host, { cwd: "/fixture" }, late.signal)).rejects.toThrow();
    expect(f.transport.request).not.toHaveBeenCalled();
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
});
