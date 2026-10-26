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

/** A model-boundary checkpoint can resume once the native queue wakes this run. */
export class SubscriptionQuotaWaitError extends Error {
  constructor(readonly retryAt: string) {
    super("Waiting for subscription capacity.");
    this.name = "SubscriptionQuotaWaitError";
  }
}
