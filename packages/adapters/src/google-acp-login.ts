import { timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAcpLocalProfile } from "./acp-local-profile.js";
import { createAcpProcessHost } from "./acp-process.js";
import type { AcpTransport } from "./acp-session.js";
import { GOOGLE_ACP_PROFILE_PATHS, validateGoogleAcpProfile } from "./google-acp-profile.js";
import type {
  NativeAccountCallbackFailure,
  NativeAccountDiagnostic,
  NativeAccountDiagnosticStage,
} from "./native-account-diagnostics.js";
import type { NativeModelLoginRunner } from "./pi-oauth.js";

const MAX_URL_BYTES = 16 * 1024;
const GOOGLE_AUTH_URL_PREFIX = "https://accounts.google.com/o/oauth2/v2/auth?";

function authorizationUrlFromStderr(text: string): string | undefined {
  const start = text.lastIndexOf(GOOGLE_AUTH_URL_PREFIX);
  if (start < 0) return undefined;
  const candidate = text.slice(start).split(/[\s"'<>\u001b]/, 1)[0];
  if (!candidate || Buffer.byteLength(candidate) > MAX_URL_BYTES) return undefined;
  return candidate.replace(/[),.;]+$/, "");
}

export interface GoogleAcpAuthorization {
  url: string;
  redirect: URL;
  state: string;
}

/** Validate the URL emitted by Google's trusted, pinned ACP process. Never log it. */
export function parseGoogleAcpAuthorization(value: string): GoogleAcpAuthorization {
  try {
    if (Buffer.byteLength(value) > MAX_URL_BYTES) throw new Error();
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== "accounts.google.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/o/oauth2/v2/auth"
    )
      throw new Error();
    for (const key of [
      "state",
      "redirect_uri",
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "response_type",
    ]) {
      if (url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key))
        throw new Error();
    }
    if (
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("code_challenge_method") !== "S256"
    )
      throw new Error();
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    validateLoopback(redirect);
    if (redirect.search || redirect.hash) throw new Error();
    return { url: url.toString(), redirect, state: url.searchParams.get("state")! };
  } catch {
    throw new Error("Google sign-in returned an unexpected authorization address");
  }
}

/** Only forward this login's complete callback to the same numeric loopback listener. */
export function googleAcpCallback(
  value: string,
  auth: GoogleAcpAuthorization,
  onFailure?: (reason: NativeAccountCallbackFailure) => void,
): URL {
  let failure: NativeAccountCallbackFailure = "invalid_url";
  try {
    if (Buffer.byteLength(value) > MAX_URL_BYTES) throw new Error();
    const input = value.trim();
    // Mobile browsers may paste the loopback address without its HTTP scheme.
    // Normalize only an exact numeric loopback authority before validating it.
    const callbackInput = /^(?:127\.0\.0\.1|\[::1\]):\d+(?:[/?#]|$)/i.test(input)
      ? `http://${input}`
      : input;
    const callback = new URL(callbackInput);
    failure = "target_mismatch";
    validateLoopback(callback);
    if (
      callback.origin !== auth.redirect.origin ||
      callback.pathname !== auth.redirect.pathname ||
      callback.hash
    )
      throw new Error();
    failure = "query_invalid";
    if (
      callback.searchParams.getAll("state").length !== 1 ||
      callback.searchParams.getAll("code").length !== 1 ||
      callback.searchParams.has("error")
    )
      throw new Error();
    failure = "state_mismatch";
    const state = Buffer.from(callback.searchParams.get("state")!);
    const expected = Buffer.from(auth.state);
    if (state.length !== expected.length || !timingSafeEqual(state, expected)) throw new Error();
    failure = "code_invalid";
    const code = callback.searchParams.get("code");
    if (!code || code.length > 8192) throw new Error();
    // Do not forward arbitrary query parameters supplied in the pasted URL.
    const target = new URL(auth.redirect);
    target.searchParams.set("state", auth.state);
    target.searchParams.set("code", code);
    return target;
  } catch {
    onFailure?.(failure);
    throw new Error("Callback does not match the current Google sign-in");
  }
}

function validateLoopback(url: URL): void {
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new Error("Invalid loopback address");
}

/**
 * Native OAuth runs in a fresh private home and returns an encrypted-store payload.
 * The Google binary performs OAuth; this adapter never calls Google's token API.
 * Must execute inside an authorized isolated login computer, not a general API host.
 */
export function createGoogleAcpLogin(options: {
  executable: string;
  args?: readonly string[];
  profileParent: string;
  onDiagnostic?: (event: NativeAccountDiagnostic) => void;
}): NativeModelLoginRunner {
  return async ({ provider, interaction, signal }) => {
    if (provider !== "google-antigravity") throw new Error("Native login provider mismatch");
    signal.throwIfAborted();
    const profile = await createAcpLocalProfile(options.profileParent);
    let transport: AcpTransport | undefined;
    const startedAt = Date.now();
    let lastStage: NativeAccountDiagnosticStage | undefined;
    let exitCode: number | null | undefined;
    let stderrTail = "";
    let stderrAuthorization: GoogleAcpAuthorization | undefined;
    const report = (
      stage: NativeAccountDiagnosticStage,
      fields: Omit<NativeAccountDiagnostic, "stage" | "durationMs"> = {},
    ) => {
      const event: NativeAccountDiagnostic = {
        stage,
        durationMs: Math.max(0, Math.min(900_000, Date.now() - startedAt)),
        ...fields,
      };
      if (stage !== "login_failed") lastStage = stage;
      try {
        options.onDiagnostic?.(event);
      } catch {
        // Fixed diagnostics cannot change login or cleanup behavior.
      }
    };
    try {
      await profile.writePrivate(
        GOOGLE_ACP_PROFILE_PATHS[0],
        Buffer.from(JSON.stringify({ auth: { type: "oauth-personal" } })),
      );
      const capture = path.join(profile.root, "authorization-url");
      const browser = path.join(profile.root, "bin", "xdg-open");
      await profile.writePrivate(
        "bin/xdg-open",
        Buffer.from('#!/bin/sh\numask 077\nprintf "%s" "$1" > "$RAKAZO_OAUTH_CAPTURE"\n'),
      );
      await chmod(browser, 0o700);
      const host = createAcpProcessHost({
        executable: options.executable,
        args: options.args,
        cwd: profile.root,
        home: profile.root,
        env: {
          GEMINI_HOME: path.join(profile.root, ".gemini"),
          AGY_ACP_FORCE_FILE_STORAGE: "1",
          BROWSER: browser,
          RAKAZO_OAUTH_CAPTURE: capture,
          PATH: `${path.dirname(browser)}:/usr/bin:/bin`,
        },
        requestTimeoutMs: 10 * 60_000,
        onStderrData(chunk) {
          stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-MAX_URL_BYTES * 2);
          const candidate = authorizationUrlFromStderr(stderrTail);
          if (candidate) {
            try {
              stderrAuthorization = parseGoogleAcpAuthorization(candidate);
            } catch {
              // Raw provider stderr and invalid URLs remain private to this process.
            }
          }
        },
        onLifecycleEvent(event) {
          if (event.type === "child-close") {
            exitCode = event.code;
            report("acp_child_exit", { exitCode: event.code });
          }
        },
      });
      transport = await host.connect(
        { update: () => {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) },
        signal,
      );
      report("acp_process_ready");
      const initialized = (await transport.request(
        "initialize",
        { protocolVersion: 1, clientCapabilities: {} },
        signal,
      )) as { protocolVersion?: number; authMethods?: Array<{ id: string }> };
      const authMethodAvailable = Boolean(
        initialized.authMethods?.some((method) => method.id === "oauth-personal"),
      );
      report("acp_initialize_complete", {
        protocolVersion: initialized.protocolVersion === 1 ? 1 : null,
        authMethodAvailable,
      });
      if (initialized.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
      if (!authMethodAvailable) throw new Error("Google personal-account login is unavailable");
      report("auth_dispatched");
      const authentication = transport.request(
        "authenticate",
        { methodId: "oauth-personal" },
        signal,
      );
      // Always observe early rejection while waiting for the browser URL.
      let authFailed = false;
      void authentication.catch(() => {
        authFailed = true;
      });
      let authorization: GoogleAcpAuthorization | undefined;
      const deadline = Date.now() + 30_000;
      while (!authorization && Date.now() < deadline) {
        signal.throwIfAborted();
        const bytes = await profile.readPrivate("authorization-url", MAX_URL_BYTES);
        if (bytes?.byteLength) {
          authorization = parseGoogleAcpAuthorization(Buffer.from(bytes).toString("utf8"));
        } else authorization = stderrAuthorization;
        if (authorization) {
          report("oauth_url_capture_checked", { urlCapturePresent: true });
          break;
        }
        if (authFailed) throw new Error("Google sign-in failed");
        await delay(100, undefined, { signal });
      }
      if (!authorization) {
        report("oauth_url_capture_checked", { urlCapturePresent: false });
        throw new Error("Google did not provide a sign-in address");
      }
      interaction.notify({
        type: "auth_url",
        url: authorization.url,
        instructions: "Sign in with Google, then paste the complete final localhost callback URL.",
      });
      const pasted = await interaction.prompt({
        type: "manual_code",
        message: "Paste the final localhost callback URL",
        placeholder: "http://127.0.0.1:PORT/?state=…&code=…",
        signal,
      });
      const callback = googleAcpCallback(pasted, authorization, (callbackFailure) => {
        report("callback_rejected", { callbackFailure });
      });
      report("callback_requested");
      const response = await fetch(callback, {
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      await response.body?.cancel();
      if (response.status >= 300) throw new Error("Google callback did not complete");
      await authentication;
      await transport.close();
      transport = undefined;
      signal.throwIfAborted();
      const files: Array<{ path: string; data: string }> = [];
      for (const filename of GOOGLE_ACP_PROFILE_PATHS) {
        const bytes = await profile.readPrivate(filename, 128 * 1024);
        if (!bytes?.byteLength) throw new Error("Google sign-in did not create account state");
        files.push({
          path: filename,
          data: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        });
      }
      const nativeProfile = validateGoogleAcpProfile({ version: 1, files });
      report("account_state_validated");
      return { kind: "native", provider, profile: nativeProfile };
    } catch {
      report("login_failed", {
        ...(lastStage ? { lastStage } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
      throw new Error(
        signal.aborted ? "Google sign-in cancelled" : "Google sign-in did not complete",
      );
    } finally {
      // Retain the private profile if the host cannot confirm native process exit.
      // Removing credentials under a still-running process is not successful cleanup.
      await transport?.close();
      await profile.dispose();
    }
  };
}
