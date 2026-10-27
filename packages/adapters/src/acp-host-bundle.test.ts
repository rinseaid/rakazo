import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("private ACP helper build boundary", () => {
  it("bundles the native helper without API database or account allocation code", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./cli/acp-host.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((name) => name.endsWith("/google-acp-host.ts"))).toBe(true);
    expect(inputs.some((name) => name.endsWith("/native-account-relay.ts"))).toBe(true);
    expect(
      inputs.filter((name) =>
        /packages\/db\/|@prisma|\/pg\/|\/(?:google-acp-remote|account-operation-host|hosted-native-account)\.ts$/.test(
          name,
        ),
      ),
    ).toEqual([]);
  });
});
