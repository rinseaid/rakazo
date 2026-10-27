import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AcpStreamTransport } from "./acp-transport.js";

function fixture(
  timeout = 1000,
  finishProcess?: () => Promise<{ clean: boolean; stopped: boolean }>,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      sent.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const stop = vi.fn(async () => {
    input.end();
    output.end();
  });
  const permission = vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } }));
  const transport = new AcpStreamTransport(
    input,
    output,
    { update: vi.fn(), permission },
    stop,
    timeout,
    finishProcess,
  );
  const receive = (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`);
  return { input, output, sent, stop, transport, receive, permission };
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ACP SDK transport", () => {
  it("correlates requests and responses through the official SDK", async () => {
    const f = fixture();
    const pending = f.transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await tick();
    const request = f.sent[0]!;
    f.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
    expect(await pending).toMatchObject({ protocolVersion: 1 });
    await f.transport.close();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("completes normal finish idempotently without calling forced stop", async () => {
    const finishProcess = vi.fn(async () => ({ clean: true, stopped: true }));
    const f = fixture(1000, finishProcess);
    const results = await Promise.all([
      f.transport.finishGracefully(),
      f.transport.finishGracefully(),
    ]);
    expect(results).toEqual([
      { clean: true, stopped: true },
      { clean: true, stopped: true },
    ]);
    expect(finishProcess).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
    await f.transport.close();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("lets forced close abort an in-progress graceful wait", async () => {
    let finish!: (value: { clean: boolean; stopped: boolean }) => void;
    const finishProcess = vi.fn(
      () => new Promise<{ clean: boolean; stopped: boolean }>((resolve) => (finish = resolve)),
    );
    const f = fixture(1000, finishProcess);
    const pending = f.transport.finishGracefully();
    await f.transport.close();
    finish({ clean: false, stopped: true });
    await expect(pending).resolves.toEqual({ clean: false, stopped: true });
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects pending requests on EOF and closes once", async () => {
    const f = fixture();
    const pending = f.transport.request("initialize", {});
    const result = expect(pending).rejects.toThrow();
    f.input.end();
    await result;
    await f.transport.close();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("closes on timeout and rejects future requests", async () => {
    const f = fixture(10);
    await expect(f.transport.request("initialize", {})).rejects.toThrow();
    await expect(f.transport.request("initialize", {})).rejects.toThrow();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("does not leak server error details", async () => {
    const f = fixture();
    const pending = f.transport.request("session/new", { cwd: "/workspace", mcpServers: [] });
    const rejection = expect(pending).rejects.toThrow("ACP request");
    await tick();
    f.receive({
      jsonrpc: "2.0",
      id: f.sent[0]!.id,
      error: { code: -32000, message: "fake-secret-value" },
    });
    await rejection;
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("refuses oversized frames", async () => {
    const f = fixture();
    const pending = f.transport.request("initialize", {});
    const rejection = expect(pending).rejects.toThrow();
    f.input.write(Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    await rejection;
    await f.transport.close();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("never implements host filesystem RPC", async () => {
    const f = fixture();
    f.receive({
      jsonrpc: "2.0",
      id: "bad",
      method: "fs/read_text_file",
      params: { sessionId: "s", path: "/private" },
    });
    await tick();
    expect(f.sent[0]).toMatchObject({ id: "bad", error: { code: -32601 } });
    await f.transport.close();
  });
});
