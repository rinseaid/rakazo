/** Opt-in ordinary lifecycle qualification. No account, session/new, prompts or tools. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createAcpProcessHost } from "../packages/adapters/src/acp-process.js";

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable))
  throw new Error("Supply an absolute trusted runtime path");
const results: Array<Record<string, unknown>> = [];
for (const mode of ["close", "close", "abort_idle", "abort_before_start"] as const) {
  const home = await mkdtemp(path.join(os.tmpdir(), "rakazo-native-check-"));
  const controller = new AbortController();
  const host = createAcpProcessHost({
    executable,
    args: ["--uid="],
    cwd: home,
    home,
    requestTimeoutMs: 15000,
    terminateGraceMs: 3000,
  });
  let transport: Awaited<ReturnType<typeof host.connect>> | undefined;
  let callbacks = 0;
  const started = performance.now();
  try {
    if (mode === "abort_before_start") controller.abort();
    const connecting = host.connect(
      {
        update: () => {
          callbacks++;
        },
        permission: async () => {
          callbacks++;
          return { outcome: { outcome: "cancelled" } };
        },
      },
      controller.signal,
    );
    if (mode === "abort_before_start") {
      await assert.rejects(connecting);
      results.push({ mode, passed: true });
      continue;
    }
    transport = await connecting;
    const initialized = (await transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "rakazo-offline-check", version: "1" },
    })) as {
      protocolVersion: number;
      agentInfo?: { version?: string };
      authMethods?: Array<{ id: string }>;
      agentCapabilities?: { loadSession?: boolean; mcpCapabilities?: { http?: boolean } };
    };
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.agentCapabilities?.loadSession, true);
    assert.equal(initialized.agentCapabilities?.mcpCapabilities?.http, true);
    assert.ok(initialized.authMethods?.some((method) => method.id === "oauth-personal"));
    const initializedMs = Math.round(performance.now() - started);
    const closing = performance.now();
    if (mode === "abort_idle") controller.abort();
    await transport.close();
    await transport.close();
    await assert.rejects(transport.request("initialize", {}));
    assert.equal(callbacks, 0);
    results.push({
      mode,
      passed: true,
      runtimeVersion: initialized.agentInfo?.version,
      initializedMs,
      closedMs: Math.round(performance.now() - closing),
      noClientCallbacks: true,
    });
  } catch {
    results.push({ mode, passed: false });
    process.exitCode = 1;
  } finally {
    try {
      await transport?.close();
    } catch {
      results.push({ mode, cleanupFailed: true });
      process.exitCode = 1;
    }
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ qualification: "native process and SDK lifecycle only", results }));
