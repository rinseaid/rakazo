import { describe, expect, it } from "vitest";
import { parseNativeAccountDiagnostic } from "./native-account-diagnostics.js";

describe("native account diagnostics", () => {
  it("accepts only bounded stage data and fixed scalar fields", () => {
    expect(
      parseNativeAccountDiagnostic({
        stage: "acp_initialize_complete",
        durationMs: 1200,
        protocolVersion: 1,
        authMethodAvailable: true,
      }),
    ).toEqual({
      stage: "acp_initialize_complete",
      durationMs: 1200,
      protocolVersion: 1,
      authMethodAvailable: true,
    });
  });

  it("accepts callback failure categories without callback contents", () => {
    expect(
      parseNativeAccountDiagnostic({
        stage: "callback_rejected",
        durationMs: 2400,
        callbackFailure: "state_mismatch",
      }),
    ).toEqual({
      stage: "callback_rejected",
      durationMs: 2400,
      callbackFailure: "state_mismatch",
    });
  });

  it.each([
    { stage: "unknown", durationMs: 10 },
    { stage: "acp_process_ready", durationMs: 900_001 },
    { stage: "acp_process_ready", durationMs: 10, exitCode: 256 },
    { stage: "acp_process_ready", durationMs: 10, protocolVersion: 2 },
    { stage: "acp_process_ready", durationMs: 10, url: "https://accounts.google.com/?code=secret" },
    { stage: "acp_process_ready", durationMs: 10, token: "fixture-token" },
    { stage: "acp_process_ready", durationMs: 10, stderr: "fixture-private-error" },
    { stage: "callback_rejected", durationMs: 10, callbackFailure: "private-code" },
  ])("rejects unbounded or sensitive fields", (event) => {
    expect(() => parseNativeAccountDiagnostic(event)).toThrow("Invalid native account diagnostic");
  });
});
