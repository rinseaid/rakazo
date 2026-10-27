import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAcpProcessHost } from "./acp-process.js";

const peer = `const readline=require('node:readline'); readline.createInterface({input:process.stdin}).on('line',line=>{ const req=JSON.parse(line); if(req.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[],agentInfo:{name:process.env.LEAK_TEST?'leaked':'isolated',version:process.env.HOME}}})+'\\n'); });`;

async function waitForFile(filename: string) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    try {
      await readFile(filename);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Test child did not become ready");
}

describe("isolated-computer ACP process driver", () => {
  it("uses EOF for a clean idempotent normal finish without forced signals", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "acp-process-finish-"));
    const marker = path.join(home, "term-signal");
    const eof = path.join(home, "eof");
    const ready = path.join(home, "ready");
    const script = `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'term');process.exit(9)});process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(eof)},'eof');process.exit(0)});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');`;
    try {
      const host = createAcpProcessHost({
        executable: process.execPath,
        args: ["-e", script],
        cwd: home,
        home,
        gracefulFinishMs: 250,
        terminateGraceMs: 20,
      });
      const transport = await host.connect({ update: vi.fn(), permission: vi.fn() });
      await waitForFile(ready);
      const results = await Promise.all([
        transport.finishGracefully!(),
        transport.finishGracefully!(),
      ]);
      expect(await readFile(eof, "utf8")).toBe("eof");
      expect(results).toEqual([
        { clean: true, stopped: true },
        { clean: true, stopped: true },
      ]);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await transport.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("escalates an abort during EOF grace and disqualifies normal finish", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "acp-process-abort-finish-"));
    const marker = path.join(home, "term-signal");
    const ready = path.join(home, "ready");
    const script = `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'term');process.exit(9)});process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),1000));require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');`;
    const controller = new AbortController();
    try {
      const host = createAcpProcessHost({
        executable: process.execPath,
        args: ["-e", script],
        cwd: home,
        home,
        gracefulFinishMs: 2000,
        terminateGraceMs: 100,
      });
      const transport = await host.connect(
        { update: vi.fn(), permission: vi.fn() },
        controller.signal,
      );
      await waitForFile(ready);
      const finish = transport.finishGracefully!();
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await expect(finish).resolves.toEqual({ clean: false, stopped: true });
      expect(await readFile(marker, "utf8")).toBe("term");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["times out and then forces cleanup", "timeout"],
    ["rejects a nonzero EOF exit", "nonzero"],
  ])("does not qualify finish when the process %s", async (_label, kind) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "acp-process-finish-fail-"));
    const ready = path.join(home, "ready");
    const script =
      kind === "timeout"
        ? `process.stdin.resume();setInterval(()=>{},1000);require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');`
        : `process.stdin.resume();process.stdin.on('end',()=>process.exit(7));require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');`;
    try {
      const host = createAcpProcessHost({
        executable: process.execPath,
        args: ["-e", script],
        cwd: home,
        home,
        gracefulFinishMs: 50,
        terminateGraceMs: 100,
      });
      const transport = await host.connect({ update: vi.fn(), permission: vi.fn() });
      await waitForFile(ready);
      await expect(transport.finishGracefully!()).resolves.toEqual({ clean: false, stopped: true });
      await transport.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects EOF completion while a descendant remains in the process group", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "acp-process-descendant-"));
    const marker = path.join(home, "descendant-term");
    const ready = path.join(home, "ready");
    const child = `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'term');process.exit(0)});setInterval(()=>{},1000);`;
    const script = `const {spawn}=require('node:child_process');let child;let stopping=false;process.stdin.resume();process.stdin.on('end',()=>{child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});child.on('exit',()=>{if(stopping)process.exit(0)});process.on('SIGTERM',()=>{stopping=true;if(child&&!child.killed)child.kill('SIGTERM');else process.exit(0)});setInterval(()=>{},1000)});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');`;
    try {
      const host = createAcpProcessHost({
        executable: process.execPath,
        args: ["-e", script],
        cwd: home,
        home,
        gracefulFinishMs: 200,
        terminateGraceMs: 200,
      });
      const transport = await host.connect({ update: vi.fn(), permission: vi.fn() });
      await waitForFile(ready);
      await expect(transport.finishGracefully!()).resolves.toEqual({ clean: false, stopped: true });
      expect(await readFile(marker, "utf8")).toBe("term");
      await transport.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("never inherits parent credentials/environment and cleans up idempotently", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "acp-process-test-"));
    vi.stubEnv("LEAK_TEST", "fake-private-fixture");
    try {
      const host = createAcpProcessHost({
        executable: process.execPath,
        args: ["-e", peer],
        cwd: home,
        home,
        terminateGraceMs: 20,
      });
      const transport = await host.connect({
        update: vi.fn(),
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
      });
      const result = await transport.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(result).toMatchObject({ agentInfo: { name: "isolated", version: home } });
      await Promise.all([transport.close(), transport.close()]);
      await expect(transport.request("initialize", {})).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("settles a pending request when its owning run is cancelled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "acp-process-test-"));
    try {
      const controller = new AbortController();
      const host = createAcpProcessHost({
        executable: process.execPath,
        args: ["-e", "process.stdin.resume();"],
        cwd: home,
        home,
        terminateGraceMs: 20,
      });
      const transport = await host.connect(
        { update: vi.fn(), permission: vi.fn() },
        controller.signal,
      );
      const pending = transport.request("initialize", {});
      const rejection = expect(pending).rejects.toThrow();
      controller.abort();
      await rejection;
      await transport.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects relative commands rather than searching ambient PATH", () => {
    expect(() => createAcpProcessHost({ executable: "agy", cwd: "/tmp", home: "/tmp" })).toThrow(
      "absolute",
    );
  });
});
