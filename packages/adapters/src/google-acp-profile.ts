import type { NativeModelProfile } from "@rakazo/adapter-kit";
import { parseNativeModelProfile } from "./model-native-auth.js";

export const GOOGLE_ACP_TOKEN_PATH = ".gemini/antigravity-acp/acp_token.json";
export const GOOGLE_ACP_SETTINGS_PATH = ".gemini/antigravity-acp/settings.json";
export const GOOGLE_ACP_PROFILE_PATHS = [GOOGLE_ACP_SETTINGS_PATH, GOOGLE_ACP_TOKEN_PATH] as const;
const PROFILE_PATHS = new Set<string>(GOOGLE_ACP_PROFILE_PATHS);

/** Validate the native file boundary before the Google process can use any credentials. */
export function validateGoogleAcpProfile(value: unknown): NativeModelProfile {
  const profile = parseNativeModelProfile(value);
  try {
    if (profile.files.length !== 2 || profile.files.some((file) => !PROFILE_PATHS.has(file.path)))
      throw new Error();
    const token = JSON.parse(
      profile.files.find((file) => file.path === GOOGLE_ACP_TOKEN_PATH)!.data,
    ) as Record<string, unknown>;
    const settings = JSON.parse(
      profile.files.find((file) => file.path === GOOGLE_ACP_SETTINGS_PATH)!.data,
    ) as { auth?: { type?: unknown } };
    if (settings.auth?.type !== "oauth-personal") throw new Error();
    if (
      ["refresh_token", "client_id", "client_secret"].some(
        (key) => typeof token[key] !== "string" || !token[key],
      )
    )
      throw new Error();
    if (token.token_uri !== "https://oauth2.googleapis.com/token") throw new Error();
    const credential = Object.fromEntries(
      ["refresh_token", "client_id", "client_secret", "token_uri", "scopes", "project_id"]
        .filter((key) => token[key] !== undefined)
        .map((key) => [key, token[key]]),
    );
    // Persist credential state only, never runtime settings or injected endpoint/tool policy.
    return {
      version: 1,
      files: [
        {
          path: GOOGLE_ACP_SETTINGS_PATH,
          data: JSON.stringify({ auth: { type: "oauth-personal" } }),
        },
        { path: GOOGLE_ACP_TOKEN_PATH, data: JSON.stringify(credential) },
      ],
    };
  } catch {
    throw new Error("Google account profile is invalid. Sign in again.");
  }
}
