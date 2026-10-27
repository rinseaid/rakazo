import type { Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { AcpProviderError, createHostedAcpProvider } from "./pi-acp-provider.js";
import { modelsForRequest, PiAgentRuntime } from "./pi-runtime.js";

const model: Model<"acp"> = {
  id: "offline-model",
  provider: "offline-acp",
  name: "Offline ACP",
  api: "acp",
  baseUrl: "",
  input: ["text"],
  reasoning: false,
  contextWindow: 32768,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const auth = {
  apiKey: {
    name: "Test",
    resolve: async () => ({ auth: {}, source: "offline test" }),
  },
};
function request(): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "offline-run",
    prompt: "Read sample",
    instructions: "Use the host's tools",
    history: [],
    tools: [
      {
        name: "read",
        description: "Read",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        readOnly: true,
      },
    ],
    model: {
      provider: model.provider,
      id: model.id,
      nativeAuth: {
        provider: model.provider,
        profile: {
          version: 1,
          files: [{ path: "account/state.json", data: "fake-profile-fixture" }],
        },
        persist: async () => true,
      },
    },
  };
}

describe("ACP through the existing Rakazo runtime", () => {
  it("executes bridged calls through the normal runtime callback and disposes the provider", async () => {
    const input = request();
    const execute = vi.fn(async () => ({ content: "sample contents" }));
    input.executeTool = execute;
    const closed = vi.fn(async () => {});
    const observed = vi.fn();
    const runtime = new PiAgentRuntime({
      createProvider: (selected, scope) => {
        expect(selected).toBe(input.model);
        expect(scope.request.runId).toBe(input.runId);
        return createHostedAcpProvider({
          id: model.provider,
          name: "Test",
          models: [model],
          auth,
          open: async ({ callTool }) => ({
            close: closed,
            prompt: async (_context, text) => {
              observed(await callTool("read", { path: "sample" }));
              text("Read complete.");
            },
          }),
        });
      },
    });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(input)) events.push(event);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.slice(0, 2)).toEqual(["read", { path: "sample" }]);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(
      events.some((event) => event.type === "text" && event.text.includes("Read complete")),
    ).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("does not leak an injected provider into other request catalogs", async () => {
    const adapter = createHostedAcpProvider({
      id: model.provider,
      name: "Test",
      models: [model],
      auth,
      open: vi.fn(),
    });
    const a = modelsForRequest(
      { model: request().model },
      model.provider,
      undefined,
      adapter.provider,
    );
    const b = modelsForRequest({ model: request().model }, model.provider);
    expect(a.getModel(model.provider, model.id)).toBeDefined();
    expect(b.getModel(model.provider, model.id)).toBeUndefined();
    expect(() =>
      modelsForRequest(
        { model: request().model },
        "another-account-provider",
        undefined,
        adapter.provider,
      ),
    ).toThrow("does not match");
    await adapter.close();
  });
  it("isolates parent and subagent providers when fallback models are configured", async () => {
    const input = request();
    input.fallbackModels = [{ provider: "offline-backup", id: "backup" }];
    input.tools = [
      {
        name: "run_subagent",
        description: "Delegate a task",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
      },
    ];
    const lifecycle: string[] = [];
    const namespaces: Array<string | undefined> = [];
    const instances: ReturnType<typeof createHostedAcpProvider>[] = [];
    const dispose = [vi.fn(), vi.fn()];
    const runtime = new PiAgentRuntime({
      createProvider: (_selected, scope) => {
        namespaces.push(scope.agentNamespace);
        const index = instances.length;
        const role = index === 0 ? "parent" : "child";
        const adapter = createHostedAcpProvider({
          id: model.provider,
          name: "Test",
          models: [model],
          auth,
          open: async ({ callTool }) => {
            lifecycle.push(`${role}:open`);
            return {
              close: async () => {
                lifecycle.push(`${role}:close`);
              },
              prompt: async (_context, text) => {
                lifecycle.push(`${role}:prompt`);
                if (index === 0) {
                  await callTool("run_subagent", { name: "helper", task: "Complete fixture" });
                  lifecycle.push("parent:resume");
                }
                text(`${role} complete`);
              },
            };
          },
        });
        instances.push(adapter);
        return {
          provider: adapter.provider,
          close: async () => {
            dispose[index]?.();
            await adapter.close();
          },
        };
      },
    });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(input)) events.push(event);

    expect(instances).toHaveLength(2);
    expect(namespaces[0]).toBe("main");
    const childEvent = events.find((event) => event.type === "subagent");
    expect(childEvent?.type === "subagent" && childEvent.agentId).toBe(namespaces[1]);
    expect(namespaces[1]).not.toBe("main");
    expect(instances[0]?.provider).not.toBe(instances[1]?.provider);
    expect(lifecycle).toEqual([
      "parent:open",
      "parent:prompt",
      "child:open",
      "child:prompt",
      "child:close",
      "parent:resume",
      "parent:close",
    ]);
    for (const close of dispose) expect(close).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "subagent", status: "completed" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "parent complete" }),
    );
  });
  it("uses the existing fallback path for a classified provider rate limit", async () => {
    const input = request();
    const backup = { ...model, provider: "offline-backup", id: "backup" };
    input.fallbackModels = [{ provider: backup.provider, id: backup.id }];
    input.resolveFallbackModel = async () => ({
      provider: backup.provider,
      id: backup.id,
      nativeAuth: {
        provider: backup.provider,
        profile: {
          version: 1,
          files: [{ path: "account/state.json", data: "fake-backup-profile" }],
        },
        persist: async () => true,
      },
    });
    const changed = vi.fn(async () => {});
    input.onModelChange = changed;
    const runtime = new PiAgentRuntime({
      createProvider: (config) => {
        const target = config.provider === model.provider ? model : backup;
        return createHostedAcpProvider({
          id: target.provider,
          name: "Test",
          models: [target],
          auth,
          open: async () => {
            if (target === model) throw new AcpProviderError("rate_limit");
            return {
              close: async () => {},
              prompt: async (_context, text) => {
                text("Backup worked.");
              },
            };
          },
        });
      },
    });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(input)) events.push(event);
    expect(changed).toHaveBeenCalledWith(backup.provider, backup.id);
    expect(
      events.some((event) => event.type === "text" && event.text.includes("Backup worked")),
    ).toBe(true);
  });
});
