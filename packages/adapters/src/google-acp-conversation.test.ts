import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { AcpConversationState } from "./acp-conversation.js";
import * as processHost from "./acp-process.js";
import { createGoogleAcpRun } from "./google-acp-provider.js";

const model: AgentRunModel = {
  provider: "google-antigravity",
  id: "fixture-model",
  nativeAuth: {
    provider: "google-antigravity",
    persist: async () => true,
    profile: {
      version: 1,
      files: [
        {
          path: ".gemini/antigravity-acp/settings.json",
          data: JSON.stringify({ auth: { type: "oauth-personal" } }),
        },
        {
          path: ".gemini/antigravity-acp/acp_token.json",
          data: JSON.stringify({
            refresh_token: "fixture",
            client_id: "fixture",
            client_secret: "fixture",
            token_uri: "https://oauth2.googleapis.com/token",
          }),
        },
      ],
    },
  },
};

describe("Google private native conversation lifecycle", () => {
  it.each([false, true])(
    "snapshots only the opaque DB after confirmed native exit (restore=%s)",
    async (restore) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "acp-conversation-test-"));
      const state: AcpConversationState = {
        version: 1,
        sessionId: "fixture-session",
        data: Buffer.from("previous-sensitive-fixture").toString("base64"),
      };
      let stopped = false;
      let loaded = false;
      const offerCandidate = vi.fn(async (next: AcpConversationState) => {
        expect(stopped).toBe(true);
        expect(next).toEqual({
          version: 1,
          sessionId: "fixture-session",
          data: Buffer.from("next-sensitive-fixture").toString("base64"),
        });
      });
      const spy = vi.spyOn(processHost, "createAcpProcessHost").mockImplementation((options) => ({
        connect: async () => ({
          request: async (method) => {
            if (method === "initialize")
              return {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
              };
            if (method === "session/load" || method === "session/new") {
              loaded = method === "session/load";
              if (loaded)
                expect(
                  await readFile(
                    path.join(
                      options.home,
                      ".gemini/antigravity-acp/conversations/fixture-session.db",
                    ),
                    "utf8",
                  ),
                ).toBe("previous-sensitive-fixture");
              return {
                sessionId: "fixture-session",
                modes: { availableModes: [{ id: "default" }] },
                models: { availableModels: [{ modelId: "fixture-model" }] },
              };
            }
            if (method === "session/prompt") return { stopReason: "end_turn" };
            return {};
          },
          notify: async () => {},
          finishGracefully: async () => {
            const folder = path.join(options.home, ".gemini/antigravity-acp/conversations");
            await mkdir(folder, { mode: 0o700, recursive: true });
            await writeFile(path.join(folder, "fixture-session.db"), "next-sensitive-fixture", {
              mode: 0o600,
            });
            await writeFile(path.join(folder, "fixture-session.meta"), "untrusted-sidecar-policy", {
              mode: 0o600,
            });
            stopped = true;
            return { clean: true, stopped: true };
          },
          close: async () => {},
        }),
      }));
      try {
        const run = await createGoogleAcpRun(
          model,
          { executable: "/fixture", workspace: parent, profileParent: parent },
          {
            tools: [],
            callTool: vi.fn(),
            signal: new AbortController().signal,
            conversation: { restore: restore ? state : undefined, offerCandidate },
          },
        );
        await run.prompt(
          normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] }),
          () => {},
          new AbortController().signal,
        );
        await run.close();
        expect(loaded).toBe(restore);
        expect(offerCandidate).toHaveBeenCalledTimes(1);
        expect(await readdir(parent)).toEqual([]);
      } finally {
        spy.mockRestore();
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  it.each(["cancelled", "close-failure", "uncheckpointed-wal"])(
    "does not publish state after %s",
    async (failure) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "acp-conversation-test-"));
      const offerCandidate = vi.fn(async () => {});
      const spy = vi.spyOn(processHost, "createAcpProcessHost").mockImplementation((options) => ({
        connect: async () => ({
          request: async (method) => {
            if (method === "initialize")
              return { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } };
            if (method === "session/new")
              return {
                sessionId: "fixture-session",
                modes: { availableModes: [{ id: "default" }] },
                models: { availableModels: [{ modelId: "fixture-model" }] },
              };
            if (method === "session/prompt")
              return { stopReason: failure === "cancelled" ? "cancelled" : "end_turn" };
            return {};
          },
          notify: async () => {},
          finishGracefully: async () => {
            if (failure === "close-failure") throw new Error("fixture cleanup failed");
            if (failure === "uncheckpointed-wal") {
              const folder = path.join(options.home, ".gemini/antigravity-acp/conversations");
              await mkdir(folder, { mode: 0o700, recursive: true });
              await writeFile(path.join(folder, "fixture-session.db-wal"), "uncheckpointed", {
                mode: 0o600,
              });
            }
            return { clean: true, stopped: true };
          },
          close: async () => {},
        }),
      }));
      try {
        const run = await createGoogleAcpRun(
          model,
          { executable: "/fixture", workspace: parent, profileParent: parent },
          {
            tools: [],
            callTool: vi.fn(),
            signal: new AbortController().signal,
            conversation: { offerCandidate },
          },
        );
        const prompt = run.prompt(
          normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] }),
          () => {},
          new AbortController().signal,
        );
        if (failure === "cancelled") {
          await expect(prompt).rejects.toThrow();
          await run.close();
        } else {
          await prompt;
          await expect(run.close()).rejects.toThrow(
            failure === "uncheckpointed-wal" ? "not quiescent" : "fixture cleanup failed",
          );
        }
        expect(offerCandidate).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  it("rejects invalid restore state before allocating a private profile", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "acp-conversation-test-"));
    try {
      await expect(
        createGoogleAcpRun(
          model,
          { executable: "/fixture", workspace: parent, profileParent: parent },
          {
            tools: [],
            callTool: vi.fn(),
            signal: new AbortController().signal,
            conversation: {
              restore: { version: 1, sessionId: "../escape", data: "YQ==" },
              offerCandidate: vi.fn(),
            },
          },
        ),
      ).rejects.toThrow("Invalid private native conversation state");
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
