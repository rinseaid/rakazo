import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { openAcpToolListener } from "./acp-mcp-listener.js";
import { createAcpToolServer } from "./acp-tool-server.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const gate = deferred();
  const effects: string[] = [];
  const signals: AbortSignal[] = [];
  const listener = await openAcpToolListener(
    createAcpToolServer(
      [
        {
          name: "effect",
          description: "Synthetic counted effect",
          parameters: Type.Object({ value: Type.String() }),
        },
      ],
      async (_name, args, signal) => {
        effects.push(String(args.value));
        signals.push(signal);
        await gate.promise;
        return {
          role: "toolResult" as const,
          toolCallId: "synthetic",
          toolName: "effect",
          timestamp: 1,
          isError: false,
          content: [{ type: "text" as const, text: String(args.value) }],
        };
      },
    ),
  );
  const controllers: AbortController[] = [];
  const headers: Record<string, string> = {
    ...Object.fromEntries(listener.endpoint.headers.map(({ name, value }) => [name, value])),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-03-26",
  };
  const post = (body: unknown) => {
    const controller = new AbortController();
    controllers.push(controller);
    const result = fetch(listener.endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]),
    }).then(
      async (response) => ({ status: response.status, body: await response.json(), response }),
      () => ({ status: 0, body: null, response: null }),
    );
    return { result, controller };
  };
  const initialized = await post({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "synthetic", version: "1" },
    },
  }).result;
  expect(initialized.status).toBe(200);
  headers["Mcp-Session-Id"] = initialized.response!.headers.get("mcp-session-id")!;
  expect(headers["Mcp-Session-Id"]).toBeTruthy();
  const call = (value = "one", id: string | number = 10) =>
    post({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "effect", arguments: { value } },
    });
  return {
    call,
    effects,
    signals,
    gate,
    async close() {
      gate.resolve();
      for (const controller of controllers) controller.abort();
      await listener.close();
    },
  };
}

describe("ACP protocol replay boundaries (real authenticated loopback HTTP)", () => {
  for (const duplicateValue of ["one", "different"]) {
    it(`does not execute a concurrently reused request ID twice (${duplicateValue})`, async () => {
      const f = await fixture();
      try {
        f.call();
        await vi.waitFor(() => expect(f.effects).toHaveLength(1));
        let duplicateSettled = false;
        const duplicate = f.call(duplicateValue);
        void duplicate.result.then(() => {
          duplicateSettled = true;
        });
        // The second request must either be rejected or reach the effect boundary.
        // Timeout is not accepted as a successful rejection.
        await vi.waitFor(() => expect(duplicateSettled || f.effects.length > 1).toBe(true));
        if (duplicateSettled) expect((await duplicate.result).status).not.toBe(0);
        expect(f.effects).toEqual(["one"]);
      } finally {
        await f.close();
      }
    });
  }

  it("does not execute a same-ID retry while the disconnected original is still pending", async () => {
    const f = await fixture();
    try {
      const first = f.call();
      await vi.waitFor(() => expect(f.effects).toHaveLength(1));
      first.controller.abort();
      expect((await first.result).status).toBe(0);
      let retrySettled = false;
      const retry = f.call();
      void retry.result.then(() => {
        retrySettled = true;
      });
      await vi.waitFor(() => expect(retrySettled || f.effects.length > 1).toBe(true));
      if (retrySettled) expect((await retry.result).status).not.toBe(0);
      expect(f.effects).toEqual(["one"]);
    } finally {
      await f.close();
    }
  });

  it("allows sequential ID reuse: a JSON-RPC correlation ID is not a durable idempotency key", async () => {
    const f = await fixture();
    try {
      f.gate.resolve();
      for (const value of ["one", "one", "different"]) {
        const result = await f.call(value).result;
        expect(result.status).toBe(200);
        expect(result.body.result.content).toEqual([{ type: "text", text: value }]);
      }
      expect(f.effects).toEqual(["one", "one", "different"]);
    } finally {
      await f.close();
    }
  });

  it("characterizes lost-response ambiguity: a completed effect can execute again on replay", async () => {
    const f = await fixture();
    try {
      const first = f.call();
      await vi.waitFor(() => expect(f.effects).toHaveLength(1));
      // Counted effect already happened; disconnect before its result is delivered.
      first.controller.abort();
      expect((await first.result).status).toBe(0);
      f.gate.resolve();
      // A different-ID request is a barrier proving the listener still works.
      expect((await f.call("barrier", 11).result).status).toBe(200);
      expect((await f.call().result).status).toBe(200);
      expect(f.effects).toEqual(["one", "barrier", "one"]);
      // This is characterization, not an exactly-once guarantee: the wire data
      // cannot distinguish a retry from legitimate sequential ID reuse above.
    } finally {
      await f.close();
    }
  });
});
