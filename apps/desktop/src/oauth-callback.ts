import type { RakazoDesktopOAuthCallback } from "@rakazo/contracts";

export type OAuthCallbackFromOptions = {
  /** SSO callbacks must reach the API, including a loopback API on a separate port. */
  frameName?: string;
  /** App renderer origins — their `/callback` routes must not be treated as paste-flow codes. */
  excludeOrigins?: readonly string[];
};

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Providers that sign in through a loopback redirect — Anthropic sends the
 * browser to `http://localhost:53692/callback` — return the authorization code
 * in the redirect URL. Rakazo runs no listener on that port and asks for the
 * code to be pasted instead, which the sign-in popup cannot show because an
 * Electron window has no address bar. The main process still sees the
 * navigation, so it captures the parsed code and full callback URL.
 */
export function oauthCallbackFrom(
  url: string,
  options: OAuthCallbackFromOptions = {},
): RakazoDesktopOAuthCallback | undefined {
  if (options.frameName === "rakazo-sso-oauth") return undefined;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  if (!LOOPBACK_HOSTS.has(target.hostname)) return undefined;
  if (target.username || target.password) return undefined;
  if (options.excludeOrigins?.includes(target.origin)) return undefined;
  const codes = target.searchParams.getAll("code");
  if (codes.length !== 1 || target.searchParams.has("error")) return undefined;
  if (target.searchParams.getAll("state").length > 1) return undefined;
  const code = codes[0]?.trim();
  if (!code) return undefined;
  const state = target.searchParams.get("state")?.trim();
  return {
    code,
    ...(state ? { state } : {}),
    callbackUrl: target.href,
  };
}
