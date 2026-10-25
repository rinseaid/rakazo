import { t } from "@lingui/core/macro";
import type { Me } from "@rakazo/contracts";
import { rpc } from "./rpc";
import { errorText } from "./user-error";

export function computersAreUnavailable(sandboxProvider: string | null | undefined): boolean {
  return sandboxProvider === "none" || sandboxProvider === "";
}

export type SandboxAvailabilityPhase = "idle" | "loading" | "recovered" | "unavailable" | "failure";

/** Lines to paste into `.env` — placeholders only, never real secrets. */
export function sandboxEnvGuidanceLines(): string[] {
  return [
    "# Pick one provider. Leave every other SANDBOX_PROVIDER line commented out.",
    "",
    "# Docker on your server or Compose stack",
    "SANDBOX_PROVIDER=docker",
    "SANDBOX_SUPERVISOR_TOKEN=<generate-a-secret>",
    "",
    "# Hosted sandbox: E2B",
    "# SANDBOX_PROVIDER=e2b",
    "# E2B_API_KEY=<your-key>",
    "",
    "# Hosted sandbox: Daytona",
    "# SANDBOX_PROVIDER=daytona",
    "# DAYTONA_API_KEY=<your-key>",
    "",
    "# Hosted sandbox: Boat",
    "# SANDBOX_PROVIDER=boat",
    "# BOAT_API_KEY=<your-key>",
    "",
    "# Your own Kubernetes cluster (the API and worker run in it)",
    "# SANDBOX_PROVIDER=kubernetes",
    "# KUBERNETES_SANDBOX_NAMESPACE=<namespace>",
    "# KUBERNETES_SANDBOX_COMPUTER_IMAGE=<computer-image-by-digest>",
    "",
    "# Recreate the stack after changing .env",
  ];
}

export function sandboxEnvGuidanceText(): string {
  return sandboxEnvGuidanceLines().join("\n");
}

export type SandboxProviderKind = "none" | "docker" | "hosted" | "other";

export function classifySandboxProvider(provider: string | null | undefined): SandboxProviderKind {
  if (provider == null || provider === "" || computersAreUnavailable(provider)) return "none";
  if (provider === "docker" || provider === "desktop") return "docker";
  if (provider === "e2b" || provider === "daytona" || provider === "boat") return "hosted";
  // Computers run in the operator's own cluster: nothing is billed, and the
  // Docker copy (sandbox supervisor, recreate the stack) does not apply.
  if (provider === "kubernetes") return "other";
  return "other";
}

export function sandboxProviderLabel(provider: string): string {
  if (provider === "docker") return "Docker";
  if (provider === "desktop") return "Desktop";
  if (provider === "e2b") return "E2B";
  if (provider === "daytona") return "Daytona";
  if (provider === "boat") return "Boat";
  if (provider === "kubernetes") return "Kubernetes";
  if (provider === "fake") return "Fake";
  return provider;
}

export async function refreshSandboxFromServer(): Promise<Me> {
  const [health, me] = await Promise.all([rpc.health(), rpc.me()]);
  if (!health.ok) {
    throw new Error("Server health check failed");
  }
  return me;
}

export function sandboxCheckFailureMessage(error: unknown): string {
  return errorText(error, t`Could not reach the server`);
}
