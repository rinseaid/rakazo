import { describe, expect, it } from "vitest";
import { oauthCallbackFrom } from "./oauth-callback.js";

describe("loopback OAuth callbacks", () => {
  it("reads the code and state Anthropic redirects with", () => {
    expect(
      oauthCallbackFrom("http://localhost:53692/callback?code=ac_123&state=verifier_456"),
    ).toEqual({
      code: "ac_123",
      state: "verifier_456",
      callbackUrl: "http://localhost:53692/callback?code=ac_123&state=verifier_456",
    });
  });

  it("accepts the loopback addresses a provider may redirect to", () => {
    expect(oauthCallbackFrom("http://127.0.0.1:53692/callback?code=ac_123")).toEqual({
      code: "ac_123",
      callbackUrl: "http://127.0.0.1:53692/callback?code=ac_123",
    });
    expect(oauthCallbackFrom("http://[::1]:53692/callback?code=ac_123")).toEqual({
      code: "ac_123",
      callbackUrl: "http://[::1]:53692/callback?code=ac_123",
    });
  });

  it("omits state when the provider redirects without one", () => {
    expect(oauthCallbackFrom("http://localhost:53692/callback?code=ac_123")).toEqual({
      code: "ac_123",
      callbackUrl: "http://localhost:53692/callback?code=ac_123",
    });
  });

  it("preserves the complete loopback URL including additional provider parameters", () => {
    const callbackUrl =
      "http://localhost:53692/callback?code=ac_123&state=verifier_456&scope=openid+email";
    expect(oauthCallbackFrom(callbackUrl)).toEqual({
      code: "ac_123",
      state: "verifier_456",
      callbackUrl,
    });
  });

  it("rejects ambiguous or credential-bearing callback URLs", () => {
    for (const callbackUrl of [
      "http://user@localhost:53692/callback?code=ac_123",
      "http://localhost:53692/callback?code=first&code=second",
      "http://localhost:53692/callback?code=ac_123&state=one&state=two",
      "http://localhost:53692/callback?code=ac_123&error=access_denied",
    ]) {
      expect(oauthCallbackFrom(callbackUrl)).toBeUndefined();
    }
  });

  it("ignores the authorize page and other steps of the flow", () => {
    expect(oauthCallbackFrom("https://claude.ai/oauth/authorize?code=true")).toBeUndefined();
    expect(oauthCallbackFrom("http://localhost:53692/callback")).toBeUndefined();
    expect(oauthCallbackFrom("http://localhost:5173/")).toBeUndefined();
  });

  it("does not treat a remote host as a loopback callback", () => {
    expect(oauthCallbackFrom("https://example.com/callback?code=ac_123")).toBeUndefined();
    expect(oauthCallbackFrom("https://localhost.example.com/callback?code=ac_123")).toBeUndefined();
  });

  it("ignores non-http schemes and unparseable targets", () => {
    expect(oauthCallbackFrom("file:///callback?code=ac_123")).toBeUndefined();
    expect(oauthCallbackFrom("rakazo://localhost/callback?code=ac_123")).toBeUndefined();
    expect(oauthCallbackFrom("not a url")).toBeUndefined();
  });

  it("ignores whitespace-only codes", () => {
    expect(oauthCallbackFrom("http://localhost:53692/callback?code=%20%20")).toBeUndefined();
  });

  it("does not capture the app renderer origin used by MCP and other in-app callbacks", () => {
    expect(
      oauthCallbackFrom("http://127.0.0.1:5173/mcp/oauth/callback?code=mcp_123&state=s", {
        excludeOrigins: ["http://127.0.0.1:5173"],
      }),
    ).toBeUndefined();
    expect(
      oauthCallbackFrom("http://localhost:53692/callback?code=ac_123", {
        excludeOrigins: ["http://127.0.0.1:5173"],
      }),
    ).toEqual({
      code: "ac_123",
      callbackUrl: "http://localhost:53692/callback?code=ac_123",
    });
  });
});

it("lets SSO reach its API callback instead of capturing a separate loopback origin", () => {
  const url = "http://127.0.0.1:3100/api/auth/callback/oidc?code=sso-code&state=sso-state";
  expect(
    oauthCallbackFrom(url, {
      frameName: "rakazo-sso-oauth",
      excludeOrigins: ["http://127.0.0.1:5173"],
    }),
  ).toBeUndefined();
  expect(
    oauthCallbackFrom("http://localhost:53692/callback?code=model-code", {
      frameName: "rakazo-model-oauth",
    }),
  ).toEqual({
    code: "model-code",
    callbackUrl: "http://localhost:53692/callback?code=model-code",
  });
});
