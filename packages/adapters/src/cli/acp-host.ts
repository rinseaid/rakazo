import { serveGoogleAcpRun } from "../google-acp-host.js";
import { loadGoogleAcpGateImage } from "../google-acp-tool-gate.js";
import { serveNativeAccountOperation } from "../native-account-relay.js";

// Installed by the qualified computer image, never downloaded from model input.
// The process wrapper controls the outer lifetime; orderly EOF closes the native tree.
const cancel = () => process.stdin.destroy();
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
try {
  const computer = {
    executable: "/opt/rakazo/antigravity-acp/agy_acp_server.par",
    args: ["--uid="],
    workspace: process.cwd(),
    profileParent: "/tmp",
  };
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 2 && args[0] === "--operation" && args[1] === "model"))
    await serveGoogleAcpRun(process.stdin, process.stdout, {
      ...computer,
      toolGateImage: await loadGoogleAcpGateImage(),
    });
  else if (
    args.length === 2 &&
    args[0] === "--operation" &&
    (args[1] === "model-login" || args[1] === "model-catalog")
  )
    await serveNativeAccountOperation(process.stdin, process.stdout, args[1], computer);
  else throw new Error("Unsupported account operation");
} catch {
  // stdout is a private protocol channel. Never print account or native diagnostic data.
  process.exitCode = 125;
} finally {
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
}
