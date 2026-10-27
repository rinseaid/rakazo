import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { restoreAcpProfile } from "./acp-profile.js";
import { AcpToolRoundtrip } from "./acp-tool-roundtrip.js";

/** Fixed-seed fuzz corpus: reproducible offline, no provider calls or real credentials. */
function random(seed: number) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
}

describe("ACP adversarial boundaries", () => {
  it("cannot enable undeclared tools by mutating the original registry", async () => {
    const names = new Set(["read"]);
    const emit = vi.fn();
    const bridge = new AcpToolRoundtrip(names, emit);
    names.add("shell");
    await expect(bridge.request("shell", {})).rejects.toThrow("not available");
    expect(emit).not.toHaveBeenCalled();
    bridge.close();
  });

  it("rejects hostile argument shapes without emitting a call", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    for (let n = 0; n < 100; n++) deep = { child: deep };
    const cases = [
      cyclic,
      deep,
      { value: NaN },
      { value: Infinity },
      { value: 1n },
      { value: () => "bad" },
      { value: new Date() },
      { value: new Map() },
      { value: undefined },
      { values: Array(10001).fill(0) },
    ];
    for (const args of cases) {
      const emit = vi.fn();
      const bridge = new AcpToolRoundtrip(new Set(["read"]), emit);
      await expect(bridge.request("read", args)).rejects.toThrow();
      expect(emit).not.toHaveBeenCalled();
      bridge.close();
    }
  });

  it("handles randomized cross-run, duplicate and reordered result delivery exactly once", async () => {
    const rng = random(0xace123);
    const calls: ToolCall[][] = [[], [], []];
    const bridges = calls.map(
      (entries) =>
        new AcpToolRoundtrip(new Set(["read"]), (call) => entries.push(call), 10000, 128),
    );
    const waiting = bridges.map((bridge) =>
      Array.from({ length: 64 }, (_, n) => bridge.request("read", { n })),
    );
    const items = calls.flatMap((entries, owner) => entries.map((call) => ({ owner, call })));
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    for (const { owner, call } of items) {
      const response: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "read",
        content: [{ type: "text", text: JSON.stringify(call.arguments) }],
        isError: false,
        timestamp: 1,
      };
      expect(bridges[(owner + 1) % 3]!.accept(response)).toBe(false);
      expect(bridges[owner]!.accept(response)).toBe(true);
      expect(bridges[owner]!.accept(response)).toBe(false);
    }
    const results = await Promise.all(waiting.flat());
    expect(results).toHaveLength(192);
    for (const bridge of bridges) bridge.close();
  });

  it("rejects malformed tool-result metadata without orphaning the parked call", async () => {
    let call!: ToolCall;
    const bridge = new AcpToolRoundtrip(new Set(["read"]), (value) => {
      call = value;
    });
    const waiting = bridge.request("read", {});
    const malformed = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 1,
      details: { bad: () => {} },
    } as unknown as ToolResultMessage;
    expect(bridge.accept(malformed)).toBe(false);
    await expect(waiting).rejects.toThrow("serialized");
    bridge.close();
  });

  it("rejects fuzzed account profiles before any filesystem write", async () => {
    const rng = random(0x123abc);
    const attackPaths = [
      "../account",
      "/etc/account",
      "account/../../other",
      "account\\other",
      "account\0",
      "other-account",
      "account/./token",
    ];
    for (let index = 0; index < 200; index++) {
      const path = attackPaths[Math.floor(rng() * attackPaths.length)]!;
      const files = {
        writePrivate: vi.fn(async () => {}),
        readPrivate: vi.fn(),
        dispose: vi.fn(async () => {}),
      };
      const data = JSON.stringify({
        version: 1,
        files: [
          { path: "account/token", data: "valid fixture" },
          { path, data: "hostile fixture" },
        ],
      });
      await expect(
        restoreAcpProfile({
          files,
          allowedPaths: ["account/token"],
          secretRef: "fixture",
          recordId: "one-account",
          store: { load: async () => data },
        }),
      ).rejects.toThrow();
      expect(files.writePrivate).not.toHaveBeenCalled();
      expect(files.dispose).toHaveBeenCalledTimes(1);
    }
  });
});
