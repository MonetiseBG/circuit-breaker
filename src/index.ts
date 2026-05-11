// Main entry point: re-exports the framework-agnostic core. Adapters live at
// dedicated subpaths so you only depend on the framework you actually use:
//
//   import { withCircuitBreaker } from "@monetisebg/circuit-breaker/langchain";
//   import { withCircuitBreaker } from "@monetisebg/circuit-breaker/openai-agents";
//
// Use the core CircuitBreaker class directly if you're building your own
// adapter for a framework we don't ship yet.
export { CircuitBreaker, CircuitBreakerError, defaultLogger } from "./core/index.js";
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
} from "./core/index.js";
