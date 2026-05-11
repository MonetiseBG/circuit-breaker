export { CircuitBreakerCallback } from "./callback.js";
export { withCircuitBreaker } from "./wrapper.js";
export type { WrappedRunnable } from "./wrapper.js";
// Re-export core symbols that users commonly need next to the adapter.
export { CircuitBreakerError } from "../core/errors.js";
export type {
  CircuitBreakerOptions,
  Limits,
  Logger,
  Metrics,
  OnTrip,
  TokenMetrics,
  TripContext,
  TripReason,
  WrapperOptions,
} from "../core/types.js";
