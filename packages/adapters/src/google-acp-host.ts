import type { Readable, Writable } from "node:stream";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import { serveHostedRunRelay } from "./acp-run-relay.js";
import type { GoogleAcpComputer } from "./google-acp-provider.js";
import { createGoogleAcpRun, validateGoogleAcpProfile } from "./google-acp-provider.js";

/** Computer-side composition with operator-owned executable/workspace paths. */
export function serveGoogleAcpRun(input: Readable, output: Writable, computer: GoogleAcpComputer) {
  return serveHostedRunRelay({
    input,
    output,
    createRun: async (scope) => {
      const value = scope.initialization;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid hosted model initialization");
      const state = value as Record<string, unknown>;
      if (
        state.provider !== "google-antigravity" ||
        typeof state.id !== "string" ||
        !state.id.trim() ||
        state.id.length > 1024
      )
        throw new Error("Invalid hosted model initialization");
      const positive = (value: unknown): number => {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
          throw new Error("Invalid hosted model limits");
        return value;
      };
      return createGoogleAcpRun(
        {
          provider: "google-antigravity",
          id: state.id,
          contextWindow: positive(state.contextWindow),
          maxTokens: positive(state.maxTokens),
          ...(state.thinkingLevel !== undefined
            ? { thinkingLevel: ThinkingLevelSchema.parse(state.thinkingLevel) }
            : {}),
          nativeAuth: {
            provider: "google-antigravity",
            profile: validateGoogleAcpProfile(state.profile),
            persist: scope.persistProfile,
          },
        },
        computer,
        scope,
      );
    },
  });
}
