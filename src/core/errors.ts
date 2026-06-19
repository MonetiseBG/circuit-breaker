import type {
  Metrics,
  Mode,
  ResolvedLimits,
  StopReason,
  TripContext,
  WorthItStepState,
} from "./types.js";

export class CircuitBreakerError extends Error {
  override readonly name = "CircuitBreakerError";
  readonly reason: StopReason;
  readonly mode: Mode;
  readonly metrics: Metrics;
  readonly limits: ResolvedLimits;
  readonly saved: number;
  /** Worth-it mode only: serialized cost/progress state at the tripping step. */
  readonly worthIt?: WorthItStepState;

  constructor(context: TripContext) {
    super(context.message);
    this.reason = context.reason;
    this.mode = context.mode;
    this.metrics = context.metrics;
    this.limits = context.limits;
    this.saved = context.saved;
    this.worthIt = context.worthIt;
  }

  toContext(): TripContext {
    return {
      reason: this.reason,
      mode: this.mode,
      metrics: this.metrics,
      limits: this.limits,
      saved: this.saved,
      message: this.message,
      ...(this.worthIt ? { worthIt: this.worthIt } : {}),
    };
  }
}
