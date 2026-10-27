import path from "node:path";
import type { NativeModelProfile } from "@rakazo/adapter-kit";
import { createAcpLocalProfile } from "./acp-local-profile.js";
import { discoverAcpModels } from "./acp-model-discovery.js";
import { createAcpProcessHost } from "./acp-process.js";
import type { AcpSessionHost } from "./acp-session.js";
import { GOOGLE_ACP_PROFILE_PATHS, validateGoogleAcpProfile } from "./google-acp-profile.js";
import type { GoogleAcpComputer } from "./google-acp-provider.js";

/** Runs only inside the private account-operation container, never the API or bot host. */
export async function discoverGoogleAcpCatalog(
  original: NativeModelProfile,
  computer: GoogleAcpComputer,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const validated = validateGoogleAcpProfile(original);
  const profile = await createAcpLocalProfile(computer.profileParent);
  let stopped = true;
  try {
    for (const file of validated.files) {
      signal.throwIfAborted();
      await profile.writePrivate(file.path, Buffer.from(file.data));
    }
    const host = createAcpProcessHost({
      executable: computer.executable,
      args: computer.args,
      cwd: profile.root,
      home: profile.root,
      env: {
        GEMINI_HOME: path.join(profile.root, ".gemini"),
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        BROWSER: "/bin/false",
      },
      requestTimeoutMs: 60_000,
    });
    const scoped: AcpSessionHost = {
      async connect(handlers, signal) {
        const transport = await host.connect(handlers, signal);
        stopped = false;
        return {
          request: (...args) => transport.request(...args),
          notify: (...args) => transport.notify(...args),
          async close() {
            await transport.close();
            stopped = true;
          },
        };
      },
    };
    const discovery = await discoverAcpModels(
      scoped,
      { cwd: profile.root, creationMetadata: { antigravity: { enabledTools: [] } } },
      signal,
    );
    signal.throwIfAborted();
    const files: NativeModelProfile["files"] = [];
    for (const filename of GOOGLE_ACP_PROFILE_PATHS) {
      const bytes = await profile.readPrivate(filename, 128 * 1024);
      if (!bytes) throw new Error("Account state is missing");
      files.push({ path: filename, data: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    }
    return { discovery, profile: validateGoogleAcpProfile({ version: 1, files }) };
  } finally {
    // The enclosing account-host lease destroys the container on unconfirmed cleanup.
    if (stopped) await profile.dispose();
  }
}
