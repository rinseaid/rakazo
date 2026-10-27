export const NATIVE_ACCOUNT_DIAGNOSTIC_STAGES = [
  "account_host_capabilities",
  "account_host_reserved",
  "account_host_provisioned",
  "process_stream_ready",
  "acp_process_ready",
  "acp_initialize_complete",
  "auth_dispatched",
  "oauth_url_capture_checked",
  "oauth_url_relayed",
  "callback_requested",
  "callback_rejected",
  "account_state_validated",
  "acp_child_exit",
  "account_host_start_failed",
  "login_failed",
] as const;

export const NATIVE_ACCOUNT_CALLBACK_FAILURES = [
  "invalid_url",
  "target_mismatch",
  "query_invalid",
  "state_mismatch",
  "code_invalid",
] as const;

export type NativeAccountCallbackFailure = (typeof NATIVE_ACCOUNT_CALLBACK_FAILURES)[number];

export type NativeAccountDiagnosticStage = (typeof NATIVE_ACCOUNT_DIAGNOSTIC_STAGES)[number];

/** Fixed, non-secret fields only. This type is also the private relay's diagnostic allowlist. */
export interface NativeAccountDiagnostic {
  stage: NativeAccountDiagnosticStage;
  durationMs: number;
  exitCode?: number | null;
  urlCapturePresent?: boolean;
  authMethodAvailable?: boolean;
  protocolVersion?: number | null;
  lastStage?: NativeAccountDiagnosticStage;
  callbackFailure?: NativeAccountCallbackFailure;
}

const stageSet = new Set<string>(NATIVE_ACCOUNT_DIAGNOSTIC_STAGES);
const allowedKeys = new Set([
  "stage",
  "durationMs",
  "exitCode",
  "urlCapturePresent",
  "authMethodAvailable",
  "protocolVersion",
  "lastStage",
  "callbackFailure",
]);

/** Reject unknown keys and unbounded/unexpected values before a diagnostic is logged. */
export function parseNativeAccountDiagnostic(value: unknown): NativeAccountDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native account diagnostic");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    typeof record.stage !== "string" ||
    !stageSet.has(record.stage) ||
    !Number.isSafeInteger(record.durationMs) ||
    (record.durationMs as number) < 0 ||
    (record.durationMs as number) > 900_000
  )
    throw new Error("Invalid native account diagnostic");
  if (
    record.exitCode !== undefined &&
    record.exitCode !== null &&
    (!Number.isSafeInteger(record.exitCode) ||
      (record.exitCode as number) < 0 ||
      (record.exitCode as number) > 255)
  )
    throw new Error("Invalid native account diagnostic");
  for (const key of ["urlCapturePresent", "authMethodAvailable"]) {
    if (record[key] !== undefined && typeof record[key] !== "boolean")
      throw new Error("Invalid native account diagnostic");
  }
  if (
    record.protocolVersion !== undefined &&
    record.protocolVersion !== null &&
    (!Number.isSafeInteger(record.protocolVersion) || record.protocolVersion !== 1)
  )
    throw new Error("Invalid native account diagnostic");
  if (
    record.lastStage !== undefined &&
    (typeof record.lastStage !== "string" || !stageSet.has(record.lastStage))
  )
    throw new Error("Invalid native account diagnostic");
  if (
    record.callbackFailure !== undefined &&
    (typeof record.callbackFailure !== "string" ||
      !NATIVE_ACCOUNT_CALLBACK_FAILURES.includes(
        record.callbackFailure as NativeAccountCallbackFailure,
      ))
  )
    throw new Error("Invalid native account diagnostic");
  return {
    stage: record.stage as NativeAccountDiagnosticStage,
    durationMs: record.durationMs as number,
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode as number | null } : {}),
    ...(record.urlCapturePresent !== undefined
      ? { urlCapturePresent: record.urlCapturePresent as boolean }
      : {}),
    ...(record.authMethodAvailable !== undefined
      ? { authMethodAvailable: record.authMethodAvailable as boolean }
      : {}),
    ...(record.protocolVersion !== undefined
      ? { protocolVersion: record.protocolVersion as number | null }
      : {}),
    ...(record.lastStage !== undefined
      ? { lastStage: record.lastStage as NativeAccountDiagnosticStage }
      : {}),
    ...(record.callbackFailure !== undefined
      ? { callbackFailure: record.callbackFailure as NativeAccountCallbackFailure }
      : {}),
  };
}
