import type { NativeModelProfile } from "@rakazo/adapter-kit";

export const MAX_NATIVE_PROFILE_BYTES = 128 * 1024;
export const GOOGLE_ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
export const GOOGLE_ANTIGRAVITY_PLACEHOLDER_MODEL_ID = "__google-antigravity-model-required__";

/** Account-managed providers never accept deployment keys or API-key substitutions. */
export function isNativeModelProvider(provider: string): boolean {
  return provider === GOOGLE_ANTIGRAVITY_PROVIDER_ID;
}

/** Native Google account support is opt-in per API process and unavailable by default. */
export function nativeModelProviderEnabled(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isNativeModelProvider(provider) && env.RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED === "true";
}

const INVALID_PROFILE = "Stored native account profile is invalid. Sign in again.";

/** Validate all opaque state before any file is restored. Runtime adapters also allowlist paths. */
export function parseNativeModelProfile(value: unknown): NativeModelProfile {
  if (!value || typeof value !== "object") throw new Error(INVALID_PROFILE);
  const profile = value as Record<string, unknown>;
  if (
    profile.version !== 1 ||
    !Array.isArray(profile.files) ||
    !profile.files.length ||
    profile.files.length > 16
  )
    throw new Error(INVALID_PROFILE);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_NATIVE_PROFILE_BYTES)
    throw new Error(INVALID_PROFILE);
  const seen = new Set<string>();
  const files = profile.files.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error(INVALID_PROFILE);
    const { path, data } = entry as Record<string, unknown>;
    if (
      typeof path !== "string" ||
      path.length > 256 ||
      !path ||
      !/^[a-zA-Z0-9._/-]+$/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(path) ||
      typeof data !== "string" ||
      !data.length
    )
      throw new Error(INVALID_PROFILE);
    seen.add(path);
    return { path, data };
  });
  return { version: 1, files };
}

export function assertNativeModelProvider(stored: string, provider: string): void {
  if (!isNativeModelProvider(stored) || stored !== provider)
    throw new Error("Native account profile does not match this provider. Sign in again.");
}
