import type { Readable, Writable } from "node:stream";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { DuplexProcess, NativeModelProfile } from "@rakazo/adapter-kit";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import type { AcpModelDiscovery } from "./acp-model-discovery.js";
import { readAcpModels } from "./acp-model-discovery.js";
import { discoverGoogleAcpCatalog } from "./google-acp-catalog.js";
import { createGoogleAcpLogin, parseGoogleAcpAuthorization } from "./google-acp-login.js";
import { validateGoogleAcpProfile } from "./google-acp-profile.js";
import type { GoogleAcpComputer } from "./google-acp-provider.js";
import {
  type NativeAccountDiagnostic,
  parseNativeAccountDiagnostic,
} from "./native-account-diagnostics.js";
import type { StoredModelSecret } from "./pi-oauth.js";

export type NativeAccountOperationInput =
  | {
      kind: "login";
      provider: "google-antigravity";
      loginId: string;
      actor: { userId: string; spaceId: string };
    }
  | { kind: "catalog"; provider: "google-antigravity"; profile: NativeModelProfile };
export type NativeAccountOperationResult =
  | { kind: "login"; secret: Extract<StoredModelSecret, { kind: "native" }> }
  | { kind: "catalog"; discovery: AcpModelDiscovery; profile: NativeModelProfile };

type Frame = { type: string; value?: unknown };
const MAX_FRAME = 256 * 1024;
const MAX_TOTAL = 512 * 1024;
const fail = () => new Error("Native account operation did not complete");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw fail();
  return value;
}
function parseInput(value: unknown): NativeAccountOperationInput {
  const input = object(value);
  if (input.provider !== "google-antigravity") throw fail();
  if (input.kind === "catalog")
    return {
      kind: "catalog",
      provider: input.provider,
      profile: validateGoogleAcpProfile(input.profile),
    };
  if (input.kind !== "login") throw fail();
  const actor = object(input.actor);
  return {
    kind: "login",
    provider: input.provider,
    loginId: identifier(input.loginId),
    actor: { userId: identifier(actor.userId), spaceId: identifier(actor.spaceId) },
  };
}
function parseDiscovery(value: unknown): AcpModelDiscovery {
  const discovery = object(value);
  if (!Array.isArray(discovery.models) || discovery.models.length > 1024) throw fail();
  if (!discovery.models.length) {
    if (discovery.currentModelId !== undefined || discovery.selection !== undefined) throw fail();
    return { models: [] };
  }
  const selection = object(discovery.selection);
  const models = discovery.models.map((value) => {
    const model = object(value);
    const thinkingLevels = model.thinkingLevels;
    if (
      typeof model.id !== "string" ||
      model.id.length > 1024 ||
      typeof model.name !== "string" ||
      model.name.length > 4096 ||
      (model.description !== undefined &&
        (typeof model.description !== "string" || model.description.length > 8192)) ||
      (thinkingLevels !== undefined &&
        (!Array.isArray(thinkingLevels) ||
          thinkingLevels.length > 7 ||
          thinkingLevels.some((level) => !ThinkingLevelSchema.safeParse(level).success)))
    )
      throw fail();
    return model;
  });
  const selectedThinkingLevels = models.find((model) => model.id === discovery.currentModelId)
    ?.thinkingLevels as string[] | undefined;
  if (models.some((model) => model.id !== discovery.currentModelId && model.thinkingLevels))
    throw fail();
  const withThinking = (result: AcpModelDiscovery): AcpModelDiscovery =>
    selectedThinkingLevels?.length
      ? {
          ...result,
          models: result.models.map((model) =>
            model.id === discovery.currentModelId
              ? { ...model, thinkingLevels: selectedThinkingLevels }
              : model,
          ),
        }
      : result;
  // Reuse the canonical ACP parser instead of trusting a serialized result cast.
  if (selection.method === "session/set_config_option")
    return withThinking(
      readAcpModels({
        configOptions: [
          {
            category: "model",
            type: "select",
            id: identifier(selection.configId),
            currentValue: discovery.currentModelId,
            options: models.map((model) => ({ ...model, value: model.id })),
          },
        ],
      }),
    );
  if (selection.method !== "session/set_model") throw fail();
  return withThinking(
    readAcpModels({
      models: {
        currentModelId: discovery.currentModelId,
        availableModels: models.map((model) => ({ ...model, modelId: model.id })),
      },
    }),
  );
}
function parseResult(
  value: unknown,
  kind: NativeAccountOperationInput["kind"],
): NativeAccountOperationResult {
  const result = object(value);
  if (result.kind !== kind) throw fail();
  if (kind === "catalog")
    return {
      kind,
      discovery: parseDiscovery(result.discovery),
      profile: validateGoogleAcpProfile(result.profile),
    };
  const secret = object(result.secret);
  if (secret.kind !== "native" || secret.provider !== "google-antigravity") throw fail();
  return {
    kind,
    secret: {
      kind: "native",
      provider: secret.provider,
      profile: validateGoogleAcpProfile(secret.profile),
    },
  };
}
function writer(write: (data: Uint8Array) => Promise<void>) {
  let chain = Promise.resolve();
  let total = 0;
  let frames = 0;
  return (frame: Frame) => {
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
    total += bytes.length;
    if (bytes.length > MAX_FRAME || total > MAX_TOTAL || ++frames > 16)
      return Promise.reject(fail());
    chain = chain.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += 65536)
        await write(bytes.subarray(offset, offset + 65536));
    });
    void chain.catch(() => undefined);
    return chain;
  };
}
async function* frames(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<Frame> {
  let buffer = Buffer.alloc(0);
  let total = 0;
  let count = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_TOTAL) throw fail();
    buffer = Buffer.concat([buffer, bytes]);
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      if (newline > MAX_FRAME || ++count > 16) throw fail();
      const value = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline))),
      );
      if (typeof value.type !== "string") throw fail();
      yield { type: value.type, value: value.value };
      buffer = buffer.subarray(newline + 1);
    }
    if (buffer.length > MAX_FRAME) throw fail();
  }
  if (buffer.length) throw fail();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(fail());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(fail());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function closeBounded(process: DuplexProcess): Promise<void> {
  const signal = AbortSignal.timeout(10_000);
  await abortable(process.close(), signal);
}

/** Server/API side: no local native process; the supplied process belongs to a private lease. */
export async function runNativeAccountOperation(
  process: DuplexProcess,
  value: NativeAccountOperationInput,
  interaction: AuthInteraction | undefined,
  signal: AbortSignal,
  onDiagnostic?: (event: NativeAccountDiagnostic) => void,
): Promise<NativeAccountOperationResult> {
  const startedAt = Date.now();
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
  const send = writer((bytes) => process.write(bytes));
  let result: NativeAccountOperationResult | undefined;
  let announced = false;
  let prompted = false;
  let pending: Promise<void> | undefined;
  const abort = () => {
    void process.close().catch(() => undefined);
  };
  lifetime.addEventListener("abort", abort, { once: true });
  try {
    lifetime.throwIfAborted();
    const input = parseInput(value);
    await abortable(send({ type: "init", value: input }), lifetime);
    async function* output() {
      for await (const event of process.events) {
        if (event.type === "stdout") yield event.data;
        // Never forward stderr. Native diagnostics may include account state.
        else if (event.type === "exit" && event.code !== 0) throw fail();
      }
    }
    const reader = frames(output());
    for (;;) {
      const next = await abortable(reader.next(), lifetime);
      if (next.done) break;
      const frame = next.value;
      lifetime.throwIfAborted();
      if (result) throw fail();
      if (frame.type === "diagnostic" && input.kind === "login") {
        const diagnostic = parseNativeAccountDiagnostic(frame.value);
        try {
          onDiagnostic?.(diagnostic);
        } catch {
          // Diagnostics never alter the account-operation result or cleanup.
        }
      } else if (
        frame.type === "auth_url" &&
        input.kind === "login" &&
        interaction &&
        !announced &&
        !prompted
      ) {
        const authorization = parseGoogleAcpAuthorization(String(frame.value));
        announced = true;
        interaction.notify({
          type: "auth_url",
          url: authorization.url,
          instructions:
            "Sign in with Google, then paste the complete final localhost callback URL.",
        });
        try {
          onDiagnostic?.({
            stage: "oauth_url_relayed",
            durationMs: Math.max(0, Math.min(900_000, Date.now() - startedAt)),
          });
        } catch {
          // Diagnostics never alter the account-operation result or cleanup.
        }
      } else if (
        frame.type === "prompt" &&
        input.kind === "login" &&
        interaction &&
        announced &&
        !prompted
      ) {
        prompted = true;
        pending = (async () => {
          const answer = await abortable(
            interaction.prompt({
              type: "manual_code",
              message: "Paste the final localhost callback URL",
              placeholder: "http://127.0.0.1:PORT/?state=…&code=…",
              signal: lifetime,
            }),
            lifetime,
          );
          if (typeof answer !== "string" || Buffer.byteLength(answer) > 16 * 1024) throw fail();
          lifetime.throwIfAborted();
          await abortable(send({ type: "answer", value: answer }), lifetime);
        })();
        void pending.catch(abort);
      } else if (frame.type === "result") {
        if (input.kind === "login" && (!prompted || !pending)) throw fail();
        if (pending) await abortable(pending, lifetime);
        result = parseResult(frame.value, input.kind);
        await abortable(process.end(), lifetime);
      } else throw fail();
    }
    if (!result || (await abortable(process.exited, lifetime)).code !== 0) throw fail();
    lifetime.throwIfAborted();
    return result;
  } catch {
    throw fail();
  } finally {
    lifetime.removeEventListener("abort", abort);
    // The outer lease still destroys the entire container even if this close fails.
    await closeBounded(process).catch(() => {
      throw fail();
    });
  }
}

/** Computer-side dispatcher, used only by the fixed account-operation helper command. */
export async function serveNativeAccountOperation(
  input: Readable,
  output: Writable,
  operation: "model-login" | "model-catalog",
  computer: GoogleAcpComputer,
): Promise<void> {
  const controller = new AbortController();
  const send = writer(
    (data) =>
      new Promise<void>((resolve, reject) => {
        output.write(data, (error) => (error ? reject(fail()) : resolve()));
      }),
  );
  let active: Promise<void> | undefined;
  let resultSent = false;
  let announced = false;
  let prompted = false;
  let answer: { resolve(value: string): void; reject(error: Error): void } | undefined;
  const outputError = () => input.destroy(fail());
  output.on("error", outputError);
  try {
    for await (const frame of frames(input)) {
      if (frame.type === "init" && !active) {
        const request = parseInput(frame.value);
        if ((request.kind === "login" ? "model-login" : "model-catalog") !== operation)
          throw fail();
        active = (async () => {
          let result: NativeAccountOperationResult;
          if (request.kind === "login") {
            const secret = await createGoogleAcpLogin({
              ...computer,
              onDiagnostic: (event) => {
                void send({ type: "diagnostic", value: event }).catch(() => input.destroy(fail()));
              },
            })({
              ...request,
              signal: controller.signal,
              interaction: {
                notify(event) {
                  if (event.type !== "auth_url" || announced || prompted) throw fail();
                  const authorization = parseGoogleAcpAuthorization(event.url);
                  announced = true;
                  void send({ type: "auth_url", value: authorization.url }).catch(() =>
                    input.destroy(fail()),
                  );
                },
                async prompt(prompt) {
                  if (
                    prompt.type !== "manual_code" ||
                    !announced ||
                    prompted ||
                    controller.signal.aborted
                  )
                    throw fail();
                  prompted = true;
                  const waiting = new Promise<string>((resolve, reject) => {
                    answer = { resolve, reject };
                  });
                  void waiting.catch(() => undefined);
                  await send({ type: "prompt" });
                  return waiting;
                },
              },
            });
            result = { kind: "login", secret };
          } else {
            result = {
              kind: "catalog",
              ...(await discoverGoogleAcpCatalog(request.profile, computer, controller.signal)),
            };
          }
          controller.signal.throwIfAborted();
          await send({ type: "result", value: parseResult(result, request.kind) });
          resultSent = true;
        })();
        void active.catch(() => input.destroy(fail()));
      } else if (
        frame.type === "answer" &&
        answer &&
        !resultSent &&
        typeof frame.value === "string" &&
        Buffer.byteLength(frame.value) <= 16 * 1024
      ) {
        const pending = answer;
        answer = undefined;
        pending.resolve(frame.value);
      } else throw fail();
    }
    if (!resultSent) throw fail();
    await active;
  } catch {
    throw fail();
  } finally {
    controller.abort();
    answer?.reject(fail());
    await active?.catch(() => undefined);
    output.removeListener("error", outputError);
  }
}
