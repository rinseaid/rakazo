import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleAcpToolGate,
  GATE_INTERPRETER,
  GATE_MANIFEST_PATH,
  GATE_SCRIPT_PATH,
  GOOGLE_ACP_GATE_SCRIPT,
  googleAcpGateFiles,
  loadGoogleAcpGateImage,
  prepareGoogleAcpToolGate,
  validateGoogleAcpGateSession,
} from "./google-acp-tool-gate.js";

const mockFiles = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (p: string) => p),
  readFile: vi.fn(async (p: string) => {
    if (!mockFiles.has(p)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return Buffer.from(mockFiles.get(p)!);
  }),
  lstat: vi.fn(async (p: string) => {
    if (!mockFiles.has(p)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100644, size: 512 };
  }),
}));
const gate = createGoogleAcpToolGate(
  "owned",
  ["read", "edit"],
  ["list_resources", "read_resource"],
);
const deployment = {
  interpreterSha256: createHash("sha256").update("pinned-node").digest("hex"),
  geminiHome: "/private/gemini",
  cwd: "/private/work",
};
const settings = {
  enabledTools: [],
  fsCapabilities: {},
  registeredServers: [{ name: "owned", toolNames: gate.projectedNames }],
};
beforeEach(() => {
  mockFiles.clear();
  const files = googleAcpGateFiles(gate, deployment);
  mockFiles.set(GATE_INTERPRETER, "pinned-node");
  mockFiles.set(GATE_SCRIPT_PATH, files.script);
  mockFiles.set(files.configPath, files.config);
});

async function runScript(name: string, args: Record<string, unknown> = {}) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      GOOGLE_ACP_GATE_SCRIPT,
      "fixture",
      JSON.stringify(gate.projectedNames),
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: {} },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.resume();
  const done = once(child, "close");
  child.stdin.end(JSON.stringify({ toolCall: { name, args } }));
  const [code] = await done;
  expect(code).toBe(0);
  return JSON.parse(output);
}

describe("optional Google ACP exact tool gate", () => {
  it("requires valid build-authored image provenance", async () => {
    await expect(loadGoogleAcpGateImage()).rejects.toThrow();
    const manifest = {
      version: 1,
      runtimeVersion: "1.4.3",
      interpreterSha256: deployment.interpreterSha256,
      scriptSha256: createHash("sha256").update(GOOGLE_ACP_GATE_SCRIPT).digest("hex"),
    };
    mockFiles.set(GATE_MANIFEST_PATH, JSON.stringify(manifest));
    await expect(loadGoogleAcpGateImage()).resolves.toEqual({
      interpreterSha256: deployment.interpreterSha256,
    });
    mockFiles.set(
      GATE_MANIFEST_PATH,
      JSON.stringify({ ...manifest, scriptSha256: "b".repeat(64) }),
    );
    await expect(loadGoogleAcpGateImage()).rejects.toThrow("mismatch");
  });
  it("has a deterministic immutable exact bijection", () => {
    expect(gate.project("read")).toMatch(/^rkz_pi_[a-f0-9]{40}$/);
    expect(gate.restore(gate.project("edit"))).toBe("edit");
    expect(Object.isFrozen(gate)).toBe(true);
    expect(Object.isFrozen(gate.projectedNames)).toBe(true);
    expect(() => gate.restore("read")).toThrow();
    expect(() => gate.project("unregistered")).toThrow();
    expect(() => createGoogleAcpToolGate("owned", ["read", "read"], [])).toThrow();
    expect(() => createGoogleAcpToolGate("owned", ["read"], [gate.project("read")])).toThrow(
      "collision",
    );
  });
  it("permits an empty registry as a text-only deny-all gate", () => {
    const empty = createGoogleAcpToolGate("owned", [], []);
    expect(empty.projectedNames).toEqual([]);
    expect(() => empty.restore("anything")).toThrow();
  });
  it("denies otherwise valid oversized tool arguments", async () => {
    expect((await runScript(gate.project("read"), { value: "x".repeat(1048576) })).allowTool).toBe(
      false,
    );
  });
  it("generates only a fixed command and enabled wildcard gate", () => {
    const files = googleAcpGateFiles(gate, deployment);
    expect(files.scriptPath).toBe(GATE_SCRIPT_PATH);
    const spec = JSON.parse(files.config)["owned-tool-gate"];
    expect(spec.enabled).toBe(true);
    expect(spec.PreToolUse).toHaveLength(1);
    expect(spec.PreToolUse[0].matcher).toBe("*");
    expect(spec.PreToolUse[0].hooks[0].command).toContain(
      `'${GATE_INTERPRETER}' '${GATE_SCRIPT_PATH}'`,
    );
  });
  it("validates the exact closed session configuration", () => {
    expect(() => validateGoogleAcpGateSession(gate, settings)).not.toThrow();
    expect(() =>
      validateGoogleAcpGateSession(gate, { ...settings, enabledTools: ["view_file"] }),
    ).toThrow();
    expect(() =>
      validateGoogleAcpGateSession(gate, { ...settings, fsCapabilities: { readTextFile: true } }),
    ).toThrow();
    expect(() =>
      validateGoogleAcpGateSession(gate, { ...settings, registeredServers: [] }),
    ).toThrow();
    expect(() =>
      validateGoogleAcpGateSession(gate, {
        ...settings,
        registeredServers: [...settings.registeredServers, ...settings.registeredServers],
      }),
    ).toThrow();
    expect(() =>
      validateGoogleAcpGateSession(gate, {
        ...settings,
        registeredServers: [{ name: "owned", toolNames: ["read"] }],
      }),
    ).toThrow();
  });
  it("requires all exact artifacts before launch", async () => {
    await expect(prepareGoogleAcpToolGate(gate, deployment, settings)).resolves.toBeUndefined();
    mockFiles.delete(GATE_SCRIPT_PATH);
    await expect(prepareGoogleAcpToolGate(gate, deployment, settings)).rejects.toThrow();
  });
  it.each([GATE_INTERPRETER, GATE_SCRIPT_PATH, "/private/gemini/config/hooks.json"])(
    "rejects integrity mismatch: %s",
    async (file) => {
      mockFiles.set(file, "different");
      await expect(prepareGoogleAcpToolGate(gate, deployment, settings)).rejects.toThrow(
        "integrity",
      );
    },
  );
  it.each([
    "/private/gemini/config/mcp_config.json",
    "/private/work/.agents/hooks.json",
    "/private/work/_agent/mcp_config.json",
  ])("rejects ambient configuration: %s", async (file) => {
    mockFiles.set(file, "{}");
    await expect(prepareGoogleAcpToolGate(gate, deployment, settings)).rejects.toThrow("Ambient");
  });
  it("permits only canonical registered bridge names", async () => {
    expect((await runScript(gate.project("read"))).allowTool).toBe(true);
    expect((await runScript("list_resources")).allowTool).toBe(false);
    expect((await runScript("read_resource")).allowTool).toBe(false);
  });
});
