import type {
  AgentRunModel,
  AgentRuntimeEvent,
  SubscriptionQuotaDeclinedError,
} from "@rakazo/adapter-kit";

type Target = Pick<AgentRunModel, "provider" | "id">;
const reasons: Record<string, string> = {
  headroom: "insufficient subscription headroom",
  stale: "quota observation is stale",
  unavailable: "verified quota is unavailable",
  reset_pending: "waiting for a fresh quota window",
  estimate_unknown: "request estimate is missing",
};

/** Audit admission decisions without exposing account identifiers or provider payloads. */
export function quotaRouteReporter(initial: Target, emit: (event: AgentRuntimeEvent) => void) {
  let selected = `${initial.provider}/${initial.id}`;
  return {
    declined(target: Target, error: SubscriptionQuotaDeclinedError) {
      const reason = Object.hasOwn(reasons, error.reason) ? error.reason : "unavailable";
      emit({
        type: "progress",
        activity: true,
        text: `Skipped ${target.provider}/${target.id}: ${reasons[reason]}.`,
        route: { action: "skipped", provider: target.provider, model: target.id, reason },
      });
    },
    admitted(target: Target) {
      const key = `${target.provider}/${target.id}`;
      if (key === selected) return;
      selected = key;
      emit({
        type: "progress",
        activity: true,
        text: `Using ${key}.`,
        route: { action: "selected", provider: target.provider, model: target.id },
      });
    },
  };
}
