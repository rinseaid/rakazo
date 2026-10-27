import { Type } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { acpToolResultEnvelopeBytes, createAcpToolServer } from "./acp-tool-server.js";

const tools = [
  { name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) },
];
describe("ACP tool MCP projection", () => {
  it("measures the UTF-8 JSON-RPC result envelope, including Unicode encoding", () => {
    const result = (text: string) => ({
      role: "toolResult" as const,
      toolName: "read",
      toolCallId: "id",
      isError: false,
      timestamp: 1,
      content: [{ type: "text" as const, text }],
    });
    const baseBytes = acpToolResultEnvelopeBytes("call", result(""));
    expect(acpToolResultEnvelopeBytes("call", result("x"))).toBe(baseBytes + 1);
    expect(acpToolResultEnvelopeBytes("call", result("雪"))).toBe(baseBytes + 3);
    const exactText = "x".repeat(32 * 1024 - baseBytes);
    expect(acpToolResultEnvelopeBytes("call", result(exactText.slice(0, -1)))).toBe(32 * 1024 - 1);
    expect(acpToolResultEnvelopeBytes("call", result(exactText))).toBe(32 * 1024);
    expect(acpToolResultEnvelopeBytes("call", result(`${exactText}x`))).toBe(32 * 1024 + 1);
  });

  it("allows a result at the limit, then fences oversized output and further dispatch", async () => {
    const resultText = "x".repeat(96);
    const makeResult = (text: string) => ({
      role: "toolResult" as const,
      toolName: "read",
      toolCallId: "call",
      isError: false,
      timestamp: 1,
      content: [{ type: "text" as const, text }],
    });
    const limit = 512;
    const call = vi.fn(async () => makeResult(resultText));
    const onResultTooLarge = vi.fn();
    const server = createAcpToolServer(tools, call, {
      maxResultEnvelopeBytes: limit,
      onResultTooLarge,
    });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const atLimit = await client.callTool({ name: "read", arguments: {} });
      expect(atLimit.isError).toBe(false);
      expect(atLimit.content).toEqual([{ type: "text", text: resultText }]);

      const oversizedCall = vi.fn(async () => makeResult("x".repeat(10_000)));
      // A separate server exercises above-limit behavior without reusing the first call.
      await client.close();
      await server.close();
      const oversizedServer = createAcpToolServer(tools, oversizedCall, {
        maxResultEnvelopeBytes: limit,
        onResultTooLarge,
      });
      const [c, d] = InMemoryTransport.createLinkedPair();
      await oversizedServer.connect(c);
      const oversizedClient = new Client({ name: "test", version: "1" });
      await oversizedClient.connect(d);
      try {
        const rejected = await oversizedClient.callTool({ name: "read", arguments: {} });
        expect(rejected.isError).toBe(true);
        expect(rejected.content).toEqual([
          {
            type: "text",
            text: "Tool executed, but its result exceeded the inline output limit and was not delivered. The run is stopping; do not repeat this call. Use a narrower or paginated request.",
          },
        ]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(onResultTooLarge).toHaveBeenCalledTimes(1);
        const refused = await oversizedClient.callTool({ name: "read", arguments: {} });
        expect(refused.isError).toBe(true);
        expect(oversizedCall).toHaveBeenCalledTimes(1);
      } finally {
        await oversizedClient.close();
        await oversizedServer.close();
      }
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("seals new dispatches and drains an already accepted callback", async () => {
    let finish!: (value: ReturnType<typeof makeResult>) => void;
    let started!: () => void;
    const callbackStarted = new Promise<void>((resolve) => (started = resolve));
    function makeResult() {
      return {
        role: "toolResult" as const,
        toolName: "read",
        toolCallId: "accepted",
        isError: false,
        timestamp: 1,
        content: [{ type: "text" as const, text: "settled" }],
      };
    }
    const call = vi.fn(() => {
      started();
      return new Promise<ReturnType<typeof makeResult>>((resolve) => (finish = resolve));
    });
    const onLateToolDispatch = vi.fn();
    const server = createAcpToolServer(tools, call, { onLateToolDispatch });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const active = client.callTool({ name: "read", arguments: {} });
      await callbackStarted;
      const drained = server.drainCallbacks(1000);
      expect(server.callbacksSettled).toBe(false);
      const late = await client.callTool({ name: "read", arguments: {} });
      expect(late.isError).toBe(true);
      expect(server.lateDispatchObserved).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(onLateToolDispatch).toHaveBeenCalledTimes(1);
      finish(makeResult());
      expect((await active).isError).toBe(false);
      expect(await drained).toBe(true);
      expect(server.callbacksSettled).toBe(true);
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes only current tools and returns the host's real denial", async () => {
    const call = vi.fn(async () => ({
      role: "toolResult" as const,
      toolName: "read",
      toolCallId: "call",
      isError: true,
      timestamp: 1,
      content: [{ type: "text" as const, text: "Denied by host" }],
    }));
    const server = createAcpToolServer(tools, call);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["read"]);
      const unavailable = await client.callTool({ name: "shell", arguments: {} });
      expect(unavailable.isError).toBe(true);
      expect(call).not.toHaveBeenCalled();
      const result = await client.callTool({ name: "read", arguments: { path: "sample" } });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Denied by host" }],
      });
      expect(call).toHaveBeenCalledWith("read", { path: "sample" }, expect.any(AbortSignal));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sanitizes bridge failures", async () => {
    const server = createAcpToolServer(tools, async () => {
      throw new Error("fake-private-value");
    });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect(JSON.stringify(await client.callTool({ name: "read", arguments: {} }))).not.toContain(
        "fake-private",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects ambiguous tool registrations", () => {
    expect(() => createAcpToolServer([...tools, ...tools], vi.fn())).toThrow("Duplicate");
  });
});
