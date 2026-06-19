// Worth-it mode: real-time predictive cost gates + a developer-driven
// progress/EVM API. Framework-agnostic — drive it from your own step loop:
//
//   import { WorthItEngine } from "@monetisebg/circuit-breaker/worth-it";
//
// The engine is exported from the package root too; this subpath exists for
// symmetry with the framework adapters and to keep imports explicit.
export {
  createWorthItRunner,
  isWorthItConfig,
  ProgressTracker,
  WorthItEngine,
} from "../core/index.js";
export { CircuitBreakerError } from "../core/index.js";
export type {
  CircuitBreakerEvent,
  CommonConfig,
  EventListener,
  Logger,
  Metrics,
  Mode,
  ModelPricing,
  OnWorthItStep,
  OptimizeContextEvent,
  PredictiveWarningEvent,
  ResolvedLimits,
  StepUsage,
  StopReason,
  TripContext,
  TrippedEvent,
  WorthItConfig,
  WorthItControls,
  WorthItMetrics,
  WorthItRunner,
  WorthItStepState,
  WorthItWrapperConfig,
} from "../core/index.js";
