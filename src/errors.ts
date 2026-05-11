import type { Limits, Metrics, TripContext, TripReason } from "./types.js";

export class CircuitBreakerError extends Error {
  override readonly name = "CircuitBreakerError";
  readonly reason: TripReason;
  readonly metrics: Metrics;
  readonly limits: Limits;

  constructor(context: TripContext) {
    super(context.message);
    this.reason = context.reason;
    this.metrics = context.metrics;
    this.limits = context.limits;
  }

  toContext(): TripContext {
    return {
      reason: this.reason,
      metrics: this.metrics,
      limits: this.limits,
      message: this.message,
    };
  }
}
