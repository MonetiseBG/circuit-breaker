export { withCircuitBreaker } from "./wrapper.js";
export type {
  ClaudeAgentSdkWrapperOptions,
  QueryFn,
  QueryParams,
  WrappedQuery,
} from "./wrapper.js";
// Re-export core symbols that users commonly need next to the adapter.
export { CircuitBreakerError } from "../core/errors.js";
export type {
  BudgetGuardConfig,
  CircuitBreakerEvent,
  CircuitBreakerOptions,
  CommonConfig,
  EventListener,
  Logger,
  LoopKillerConfig,
  Metrics,
  Mode,
  ModeConfig,
  OnTrip,
  ResolvedLimits,
  StopReason,
  TokenMetrics,
  TripContext,
  WrapperOptions,
} from "../core/types.js";
