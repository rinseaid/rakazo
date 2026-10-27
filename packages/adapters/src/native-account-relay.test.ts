import { PassThrough } from "node:stream";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { DuplexProcess } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GoogleAcpLogin from "./google-acp-login.js";
import type { NativeAccountDiagnostic } from "./native-account-diagnostics.js";
import type { NativeAccountOperationInput } from "./native-account-relay.js";
import { runNativeAccountOperation, serveNativeAccountOperation } from "./native-account-relay.js";

const mock = vi.hoisted(() => ({ login: vi.fn(), catalog: vi.fn() }));
vi.mock("./google-acp-login.js", async (original) => ({
  ...(await original<typeof GoogleAcpLogin>()),
  createGoogleAcpLogin:
    (options: { onDiagnostic?: (event: NativeAccountDiagnostic) => void }) =>
    (input: Record<string, unknown>) =>
      mock.login({ ...input, onDiagnostic: options.onDiagnostic }),
}));
vi.mock("./google-acp-catalog.js", () => ({ discoverGoogleAcpCatalog: mock.catalog }));
const profile = {
  version: 1 as const,
  files: [
    {
      path: ".gemini/antigravity-acp/settings.json",
      data: JSON.stringify({ auth: { type: "oauth-personal" } }),
    },
    {
      path: ".gemini/antigravity-acp/acp_token.json",
      data: JSON.stringify({
        refresh_token: "fixture-refresh",
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    },
  ],
};
const secret = { kind: "native" as const, provider: "google-antigravity", profile };
const catalog = {
  discovery: {
    models: [{ id: "fixture", name: "Fixture" }],
    currentModelId: "fixture",
    selection: { method: "session/set_model" },
  },
  profile,
};
const loginInput: NativeAccountOperationInput = {
  kind: "login",
  provider: "google-antigravity",
  loginId: "fixture-login",
  actor: { userId: "fixture-user", spaceId: "fixture-space" },
};
const catalogInput: NativeAccountOperationInput = {
  kind: "catalog",
  provider: "google-antigravity",
  profile,
};
const computer = {
  executable: "/fixture/native",
  profileParent: "/fixture",
  workspace: "/fixture",
};
const signal = () => new AbortController().signal;
function authorization() {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [key, value] of Object.entries({
    state: "fixture-state",
    redirect_uri: "http://127.0.0.1:12345/callback",
    client_id: "fixture-client",
    code_challenge: "fixture-challenge",
    code_challenge_method: "S256",
    response_type: "code",
  }))
    url.searchParams.set(key, value);
  return url.toString();
}
function host(operation: "model-login" | "model-catalog") {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: string[] = [];
  const exited = serveNativeAccountOperation(input, output, operation, computer)
    .then(
      () => ({ code: 0 }),
      () => ({ code: 125 }),
    )
    .finally(() => output.end());
  const process: DuplexProcess = {
    events: (async function* () {
      for await (const chunk of output) yield { type: "stdout" as const, data: chunk.toString() };
    })(),
    async write(data) {
      writes.push(Buffer.from(data).toString());
      input.write(data);
    },
    async end() {
      input.end();
    },
    async close() {
      input.destroy();
      await exited;
    },
    exited,
  };
  return { process, input, output, writes };
}
function scripted(frames: unknown[], code = 0): DuplexProcess {
  return {
    events: (async function* () {
      yield { type: "stderr" as const, data: "fixture-private-diagnostic" };
      for (const frame of frames)
        yield { type: "stdout" as const, data: `${JSON.stringify(frame)}\n` };
    })(),
    write: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    exited: Promise.resolve({ code }),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.login.mockImplementation(async ({ interaction }: { interaction: AuthInteraction }) => {
    interaction.notify({ type: "auth_url", url: authorization() });
    expect(await interaction.prompt({ type: "manual_code", message: "unused" })).toBe(
      "fixture-answer",
    );
    return secret;
  });
  mock.catalog.mockResolvedValue(catalog);
});

describe("isolated native account relay", () => {
  it("relays shared login interaction and waits for clean helper exit", async () => {
    const fixture = host("model-login");
    const interaction = { notify: vi.fn(), prompt: vi.fn(async () => "fixture-answer") };
    await expect(
      runNativeAccountOperation(fixture.process, loginInput, interaction, signal()),
    ).resolves.toEqual({ kind: "login", secret });
    expect(interaction.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "auth_url", url: authorization() }),
    );
    expect(await fixture.process.exited).toEqual({ code: 0 });
    expect(fixture.writes.join("")).not.toContain("fixture-secret");
  });
  it("returns an account-scoped catalog and refreshed profile without interaction", async () => {
    const fixture = host("model-catalog");
    await expect(
      runNativeAccountOperation(fixture.process, catalogInput, undefined, signal()),
    ).resolves.toEqual({ kind: "catalog", ...catalog });
    expect(mock.login).not.toHaveBeenCalled();
    expect(mock.catalog).toHaveBeenCalledWith(profile, computer, expect.any(AbortSignal));
  });
  it("rejects a wrong operation before invoking a runner", async () => {
    const fixture = host("model-catalog");
    await expect(
      runNativeAccountOperation(fixture.process, loginInput, undefined, signal()),
    ).rejects.toThrow("Native account operation did not complete");
    expect(mock.login).not.toHaveBeenCalled();
    expect(mock.catalog).not.toHaveBeenCalled();
  });
  it("rejects a failed helper exit even after a valid result", async () => {
    await expect(
      runNativeAccountOperation(
        scripted([{ type: "result", value: { kind: "catalog", ...catalog } }], 125),
        catalogInput,
        undefined,
        signal(),
      ),
    ).rejects.toThrow("Native account operation did not complete");
  });
  it("forwards only sanitized native stage diagnostics", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    await expect(
      runNativeAccountOperation(
        scripted([
          {
            type: "diagnostic",
            value: {
              stage: "acp_initialize_complete",
              durationMs: 123,
              protocolVersion: 1,
              authMethodAvailable: true,
            },
          },
          { type: "auth_url", value: authorization() },
          { type: "prompt" },
          { type: "result", value: { kind: "login", secret } },
        ]),
        loginInput,
        { notify: vi.fn(), prompt: vi.fn(async () => "fixture-answer") },
        signal(),
        (event) => diagnostics.push(event),
      ),
    ).resolves.toEqual({ kind: "login", secret });
    expect(diagnostics[0]).toEqual({
      stage: "acp_initialize_complete",
      durationMs: 123,
      protocolVersion: 1,
      authMethodAvailable: true,
    });
    expect(diagnostics.at(-1)).toEqual({
      stage: "oauth_url_relayed",
      durationMs: expect.any(Number),
    });
    const serialized = JSON.stringify(diagnostics);
    for (const sensitive of ["fixture-state", "fixture-client", "fixture-answer", "fixture-secret"])
      expect(serialized).not.toContain(sensitive);
  });
  it("carries a synthetic diagnostic from the private helper through the native protocol", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    mock.login.mockImplementation(
      async ({
        interaction,
        onDiagnostic,
      }: {
        interaction: AuthInteraction;
        onDiagnostic?: (event: NativeAccountDiagnostic) => void;
      }) => {
        onDiagnostic?.({
          stage: "acp_initialize_complete",
          durationMs: 23,
          protocolVersion: 1,
          authMethodAvailable: true,
        });
        interaction.notify({ type: "auth_url", url: authorization() });
        await interaction.prompt({ type: "manual_code", message: "fixture" });
        return secret;
      },
    );
    const fixture = host("model-login");
    const result = await runNativeAccountOperation(
      fixture.process,
      loginInput,
      { notify: vi.fn(), prompt: vi.fn(async () => "fixture-answer") },
      signal(),
      (event) => diagnostics.push(event),
    );
    expect(result).toEqual({ kind: "login", secret });
    expect(diagnostics[0]).toEqual({
      stage: "acp_initialize_complete",
      durationMs: 23,
      protocolVersion: 1,
      authMethodAvailable: true,
    });
    expect(diagnostics.at(-1)).toMatchObject({ stage: "oauth_url_relayed" });
    expect(JSON.stringify(diagnostics)).not.toContain("fixture-state");
  });
  it("rejects diagnostic frames containing URLs, tokens or process output", async () => {
    for (const extra of [
      { url: "https://accounts.google.com/?code=fixture-secret" },
      { token: "fixture-secret" },
      { stderr: "fixture-private-error" },
    ]) {
      const diagnostics: Array<Record<string, unknown>> = [];
      await expect(
        runNativeAccountOperation(
          scripted([
            {
              type: "diagnostic",
              value: { stage: "acp_process_ready", durationMs: 20, ...extra },
            },
          ]),
          loginInput,
          undefined,
          signal(),
          (event) => diagnostics.push(event),
        ),
      ).rejects.toThrow("Native account operation did not complete");
      expect(diagnostics).toEqual([]);
    }
  });
  it.each([
    [{ type: "prompt" }],
    [{ type: "auth_url", value: "https://example.test/private" }],
    [{ type: "result", value: { kind: "login", secret } }],
    [
      { type: "result", value: { kind: "catalog", ...catalog } },
      { type: "result", value: { kind: "catalog", ...catalog } },
    ],
    [
      {
        type: "result",
        value: {
          kind: "catalog",
          ...catalog,
          discovery: {
            models: [{ id: "x", name: "X" }],
            currentModelId: "missing",
            selection: { method: "session/set_model" },
          },
        },
      },
    ],
  ])("rejects unexpected or malformed output without echoing diagnostics", async (...frames) => {
    await expect(
      runNativeAccountOperation(scripted(frames), catalogInput, undefined, signal()),
    ).rejects.toThrow(/^Native account operation did not complete$/);
  });
  it("does not start an already-cancelled operation", async () => {
    const process = scripted([]);
    await expect(
      runNativeAccountOperation(process, catalogInput, undefined, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(process.write).not.toHaveBeenCalled();
    expect(process.close).toHaveBeenCalledOnce();
  });
  it("aborts an in-flight runner when the parent input disappears", async () => {
    let cancelled = false;
    mock.catalog.mockImplementation(
      (_profile, _computer, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("fixture-private-error"));
            },
            { once: true },
          ),
        ),
    );
    const fixture = host("model-catalog");
    await fixture.process.write(
      Buffer.from(`${JSON.stringify({ type: "init", value: catalogInput })}\n`),
    );
    await vi.waitFor(() => expect(mock.catalog).toHaveBeenCalledOnce());
    await fixture.process.end();
    expect(await fixture.process.exited).toEqual({ code: 125 });
    expect(cancelled).toBe(true);
  });
  it("bounds untrusted frames", async () => {
    const process = scripted([{ type: "result", value: "x".repeat(300 * 1024) }]);
    await expect(
      runNativeAccountOperation(process, catalogInput, undefined, signal()),
    ).rejects.toThrow(/^Native account operation did not complete$/);
  });
  it("cancels while a user prompt ignores its signal", async () => {
    const fixture = host("model-login");
    const controller = new AbortController();
    const interaction = { notify: vi.fn(), prompt: vi.fn(() => new Promise<string>(() => {})) };
    const pending = runNativeAccountOperation(
      fixture.process,
      loginInput,
      interaction,
      controller.signal,
    );
    await vi.waitFor(() => expect(interaction.prompt).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow(/^Native account operation did not complete$/);
    expect(await fixture.process.exited).toEqual({ code: 125 });
  });
  it("rejects repeated prompts instead of issuing a second user interaction", async () => {
    const interaction = { notify: vi.fn(), prompt: vi.fn(async () => "fixture-answer") };
    const process = scripted([
      { type: "auth_url", value: authorization() },
      { type: "prompt" },
      { type: "prompt" },
    ]);
    await expect(
      runNativeAccountOperation(process, loginInput, interaction, signal()),
    ).rejects.toThrow();
    expect(interaction.prompt).toHaveBeenCalledOnce();
  });
  it("rejects oversized pasted input before it crosses the host channel", async () => {
    const interaction = { notify: vi.fn(), prompt: vi.fn(async () => "x".repeat(16385)) };
    const process = scripted([
      { type: "auth_url", value: authorization() },
      { type: "prompt" },
      { type: "result", value: { kind: "login", secret } },
    ]);
    await expect(
      runNativeAccountOperation(process, loginInput, interaction, signal()),
    ).rejects.toThrow();
    expect(process.write).toHaveBeenCalledOnce();
  });
});
