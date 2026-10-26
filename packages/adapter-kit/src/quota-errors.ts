/** Capacity admission is distinct from provider failures and local billing errors. */
export class SubscriptionQuotaDeclinedError extends Error {
  constructor(
    readonly reason: string,
    readonly retryAt: string,
  ) {
    super("Subscription capacity is unavailable.");
    this.name = "SubscriptionQuotaDeclinedError";
  }
}
