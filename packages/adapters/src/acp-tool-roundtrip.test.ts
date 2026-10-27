import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AcpToolRoundtrip } from "./acp-tool-roundtrip.js";

function result(call: ToolCall, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: "result" }],
    isError,
    timestamp: 1,
  };
}

describe("ACP tool round trips", () => {
  it("parks for the real Agent result and preserves denial/error", async () => {
    const emit = vi.fn();
    const bridge = new AcpToolRoundtrip(new Set(["read"]), emit);
    const pending = bridge.request("read", { path: "sample" });
    const call = emit.mock.calls[0]![0] as ToolCall;
    const denied = result(call, true);
    expect(bridge.accept(denied)).toBe(true);
    expect(await pending).toEqual(denied);
    expect(bridge.accept(denied)).toBe(false);
    bridge.close();
  });

  it("rejects undeclared tools without emitting an action", async () => {
    const emit = vi.fn();
    const bridge = new AcpToolRoundtrip(new Set(["read"]), emit);
    await expect(bridge.request("shell", {})).rejects.toThrow("not available");
    expect(emit).not.toHaveBeenCalled();
    bridge.close();
  });

  it("cannot consume another run's tool result", async () => {
    const calls: ToolCall[] = [];
    const a = new AcpToolRoundtrip(new Set(["read"]), (call) => calls.push(call));
    const b = new AcpToolRoundtrip(new Set(["read"]), (call) => calls.push(call));
    const first = a.request("read", {});
    const second = b.request("read", {});
    expect(b.accept(result(calls[0]!))).toBe(false);
    expect(a.accept(result(calls[1]!))).toBe(false);
    a.accept(result(calls[0]!));
    b.accept(result(calls[1]!));
    await Promise.all([first, second]);
    a.close();
    b.close();
  });

  it("fails a mismatched result rather than forwarding it", async () => {
    let call!: ToolCall;
    const bridge = new AcpToolRoundtrip(new Set(["read"]), (value) => {
      call = value;
    });
    const pending = bridge.request("read", {});
    expect(bridge.accept({ ...result(call), toolName: "write" })).toBe(false);
    await expect(pending).rejects.toThrow("mismatch");
    bridge.close();
  });

  it("copies arguments and returned results", async () => {
    let call!: ToolCall;
    const bridge = new AcpToolRoundtrip(new Set(["read"]), (value) => {
      call = value;
    });
    const args = { path: "original" };
    const pending = bridge.request("read", args);
    args.path = "changed";
    expect(call.arguments.path).toBe("original");
    const response = result(call);
    bridge.accept(response);
    response.content = [];
    expect((await pending).content).toHaveLength(1);
    bridge.close();
  });

  it("clears parked calls on cancellation, timeout and closure", async () => {
    const emit = vi.fn();
    const bridge = new AcpToolRoundtrip(new Set(["read"]), emit, 10);
    const controller = new AbortController();
    const first = bridge.request("read", {}, controller.signal);
    controller.abort();
    await expect(first).rejects.toThrow("aborted");
    await expect(bridge.request("read", {})).rejects.toThrow("timed out");
    const last = bridge.request("read", {});
    bridge.close();
    await expect(last).rejects.toThrow("closed");
    await expect(bridge.request("read", {})).rejects.toThrow("closed");
  });

  it("bounds pending calls and handles failed delivery", async () => {
    const bridge = new AcpToolRoundtrip(new Set(["read"]), () => {}, 1000, 1);
    const pending = bridge.request("read", {});
    await expect(bridge.request("read", {})).rejects.toThrow("concurrency");
    bridge.close();
    await expect(pending).rejects.toThrow("closed");
    const broken = new AcpToolRoundtrip(new Set(["read"]), () => {
      throw new Error("private detail");
    });
    await expect(broken.request("read", {})).rejects.toThrow("could not be delivered");
    broken.close();
  });
});
