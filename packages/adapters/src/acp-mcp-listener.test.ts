import { Type } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { openAcpToolListener } from "./acp-mcp-listener.js";
import { createAcpToolServer } from "./acp-tool-server.js";

describe("scoped loopback ACP tool listener", () => {
  it("requires the per-run capability and exposes only current tools", async () => {
    const execute = vi.fn(async () => ({
      role: "toolResult" as const,
      toolCallId: "fixture",
      toolName: "read",
      isError: false,
      timestamp: 1,
      content: [{ type: "text" as const, text: "fixture-result" }],
    }));
    const listener = await openAcpToolListener(
      createAcpToolServer(
        [{ name: "read", description: "Read", parameters: Type.Object({}) }],
        execute,
      ),
    );
    const client = new Client({ name: "fake-agent", version: "1" });
    try {
      expect((await fetch(listener.endpoint.url, { method: "POST", body: "{}" })).status).toBe(401);
      const headers = Object.fromEntries(
        listener.endpoint.headers.map(({ name, value }) => [name, value]),
      );
      expect(
        (
          await fetch(listener.endpoint.url, {
            method: "POST",
            headers: { ...headers, Origin: "https://attacker.invalid" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(listener.endpoint.url), {
          requestInit: { headers },
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["read"]);
      expect((await client.callTool({ name: "read", arguments: {} })).content).toEqual([
        { type: "text", text: "fixture-result" },
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await listener.close();
      await listener.close();
    }
  });
});
