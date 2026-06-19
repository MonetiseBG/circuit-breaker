export type Mode = "budget-guard" | "loop-killer" | "worth-it";

export type StopReason =
  | "max_input_tokens"
  | "max_output_tokens"
  | "max_retries"
  | "repeated_state"
  | "budget_projection";

export interface TokenMetrics {
  input: number;
  output: number;
  total: number;
}

export interface Metrics {
  iterations: number;
  retries: number;
  tokens: TokenMetrics;
}

/**
 * Optional preflight estimator. Adapters call this with the raw input the user
 * is about to send and trip the breaker before the provider call if the
 * estimate exceeds `maxInputToken`. Return `undefined` to skip the check (e.g.
 * the input shape is unfamiliar). The package does not bundle a tokenizer:
 * supply your own via `js-tiktoken`, `tiktoken`, or a provider SDK.
 */
export type EstimateInputTokens<TInput = unknown> = (
  input: TInput,
) => number | undefined;

export interface RetryEvent {
  type: "retry";
  retries: number;
}

export interface StopEvent {
  type: "stop";
  reason: StopReason;
  saved: number;
}

/**
 * Worth-it mode: projected total cost crossed the `warn` threshold
 * (default `0.70 · B_limit`). Advisory only — execution continues.
 */
export interface PredictiveWarningEvent {
  type: "predictive_warning";
  state: WorthItStepState;
}

/**
 * Worth-it mode: projected total cost crossed the `optimize` threshold
 * (default `0.85 · B_limit`). The application should compact context, compress
 * history, or swap to a cheaper downstream model. Execution continues.
 */
export interface OptimizeContextEvent {
  type: "optimize_context";
  state: WorthItStepState;
}

/**
 * Worth-it mode: projected total cost crossed the `trip` threshold
 * (default `0.95 · B_limit`). The breaker checkpoints and pauses the run — a
 * {@link CircuitBreakerError} is thrown alongside this event. Carries the
 * serialized state of the run up to the tripping step.
 */
export interface TrippedEvent {
  type: "tripped";
  reason: "budget_projection";
  state: WorthItStepState;
}

export type CircuitBreakerEvent =
  | RetryEvent
  | StopEvent
  | PredictiveWarningEvent
  | OptimizeContextEvent
  | TrippedEvent;

export type Logger = (message: string, context: TripContext) => void;
export type EventListener = (event: CircuitBreakerEvent) => void;

export interface CommonConfig {
  /** Suppress the default trip log. */
  silent?: boolean;
  /** Custom logger for trips. Ignored when `silent: true`. */
  logger?: Logger;
  /** Listener for breaker lifecycle events ({@link CircuitBreakerEvent}). */
  onEvent?: EventListener;
}

export interface BudgetGuardConfig<TInput = unknown> extends CommonConfig {
  mode: "budget-guard";
  /** Maximum aggregate input tokens. Default: 10_000. */
  maxInputToken?: number;
  /** Maximum aggregate output tokens. Default: 10_000. */
  maxOutputToken?: number;
  /** Optional preflight estimator; see {@link EstimateInputTokens}. */
  estimateInputTokens?: EstimateInputTokens<TInput>;
}

export interface LoopKillerConfig extends CommonConfig {
  mode: "loop-killer";
  /** Max times any single state may repeat (or, with detectRepeatedState=false,
   *  max raw iterations) before tripping. Default: 3. */
  maxRetries?: number;
  /** Hash each step's state to detect loops. Default: true. */
  detectRepeatedState?: boolean;
}

/**
 * `mode` omitted — applies budget-guard defaults. Same fields as
 * {@link BudgetGuardConfig} but with an absent discriminator. Modelled as a
 * separate arm so `{ maxRetries: 5 }` (no mode) is a type error rather than
 * silently dropped.
 */
export interface DefaultModeConfig<TInput = unknown> extends CommonConfig {
  mode?: undefined;
  /** Maximum aggregate input tokens. Default: 10_000. */
  maxInputToken?: number;
  /** Maximum aggregate output tokens. Default: 10_000. */
  maxOutputToken?: number;
  /** Optional preflight estimator; see {@link EstimateInputTokens}. */
  estimateInputTokens?: EstimateInputTokens<TInput>;
}

export type ModeConfig<TInput = unknown> =
  | BudgetGuardConfig<TInput>
  | LoopKillerConfig;

export type CircuitBreakerOptions<TInput = unknown> =
  | BudgetGuardConfig<TInput>
  | LoopKillerConfig
  | DefaultModeConfig<TInput>;

/**
 * Mode config accepted at the wrapper layer: the core {@link CircuitBreakerOptions}
 * (`budget-guard` / `loop-killer`) plus the `worth-it` engine mode. The core
 * `CircuitBreaker` class itself only accepts {@link CircuitBreakerOptions};
 * `worth-it` is handled by `WorthItEngine` inside the adapters.
 */
export type WrapperModeConfig<TInput = unknown> =
  | CircuitBreakerOptions<TInput>
  | WorthItWrapperConfig;

export interface ResolvedLimits {
  mode: Mode;
  maxInputToken?: number;
  maxOutputToken?: number;
  maxRetries?: number;
  detectRepeatedState?: boolean;
}

export interface TripContext {
  reason: StopReason;
  mode: Mode;
  metrics: Metrics;
  limits: ResolvedLimits;
  /**
   * Remaining headroom at trip time: `limit - usage` (signed).
   * - budget-guard: `(maxInputToken + maxOutputToken) - tokens.total`.
   * - loop-killer:  `maxRetries - retries`, where `retries` is the
   *   per-state recurrence depth (detection on) or `iterations - 1`
   *   (detection off).
   *
   * Negative values mean we tripped after overshooting the limit (the call
   * that pushed us over still counts).
   */
  saved: number;
  message: string;
  /**
   * Present only for `worth-it` mode trips: the serialized cost/progress state
   * of the run at the step that tripped the breaker.
   */
  worthIt?: WorthItStepState;
}

export type OnTrip<R> = (context: TripContext) => R | Promise<R>;

// ---------------------------------------------------------------------------
// Worth-it mode: real-time predictive cost gates + progress/EVM API.
// ---------------------------------------------------------------------------

/**
 * Per-million-token prices for a model, expressed in the **smallest unit** of
 * the run's {@link WorthItConfig.currency} (e.g. cents for USD). Prices are
 * quoted **per 1,000,000 tokens** — the figure providers publish — so a model
 * billed at $3.00 / 1M input tokens is `inputPerMToken: 300` (300 cents).
 *
 * Cache read/write prices are optional; when omitted, cache tokens (if supplied
 * on a step) are priced at the regular input rate.
 */
export interface ModelPricing {
  /** `P_in` — price per 1M input (prompt) tokens, in the currency's smallest unit. */
  inputPerMToken: number;
  /** `P_out` — price per 1M output (completion/reasoning) tokens, smallest unit. */
  outputPerMToken: number;
  /** Optional price per 1M cache-read tokens. Defaults to `inputPerMToken`. */
  cacheReadPerMToken?: number;
  /** Optional price per 1M cache-write tokens. Defaults to `inputPerMToken`. */
  cacheWritePerMToken?: number;
}

/**
 * Token telemetry for a single completed step, extracted from the provider's
 * API response. `input`/`output` map to `I_s`/`O_s`.
 */
export interface StepUsage {
  /** `I_s` — input (prompt) tokens processed in this step. */
  input: number;
  /** `O_s` — output (completion/reasoning) tokens generated in this step. */
  output: number;
  /** Model active in this step. Looked up in `pricing`; falls back to default. */
  model?: string;
  /** Optional cache-read tokens, priced via `cacheReadPerMToken`. */
  cacheReadTokens?: number;
  /** Optional cache-write tokens, priced via `cacheWritePerMToken`. */
  cacheWriteTokens?: number;
}

export interface WorthItConfig extends CommonConfig {
  mode?: "worth-it";
  /**
   * `B_limit` — maximum budget ceiling for the run, in the **smallest unit** of
   * {@link currency} (e.g. cents for USD). Required. A $5.00 ceiling is `500`.
   */
  budgetLimit: number;
  /**
   * ISO 4217 code for the currency the whole price list (and {@link budgetLimit})
   * is expressed in — purely informational, carried on emitted state and used to
   * format log messages. All amounts are in this currency's smallest unit.
   * Default: `"USD"`.
   */
  currency?: string;
  /**
   * Planned milestones `M`. Pass an array of labels or a positive integer
   * count. `N_total = |M|`. Required and non-empty (avoids divide-by-zero).
   */
  milestones: readonly string[] | number;
  /** `α` — EMA smoothing factor in (0, 1]. Default: 0.3. */
  alpha?: number;
  /** Per-model price table, keyed by model id. */
  pricing?: Record<string, ModelPricing>;
  /** Fallback pricing when a step's model is absent from `pricing`. */
  defaultPricing?: ModelPricing;
  /** `warn` threshold as a fraction of `budgetLimit`. Default: 0.70. */
  warnRatio?: number;
  /** `optimize` threshold as a fraction of `budgetLimit`. Default: 0.85. */
  optimizeRatio?: number;
  /** `trip` (checkpoint & pause) threshold as a fraction. Default: 0.95. */
  tripRatio?: number;
}

/**
 * Resolved cost/progress snapshot for a single step. This is the payload
 * carried by Worth-it events and by {@link CircuitBreakerError.worthIt}.
 */
export interface WorthItStepState {
  /** 1-based step index `s`. */
  step: number;
  /** `C_s` — actual cost of this step. */
  stepCost: number;
  /** `EMA_s` — smoothed step-cost average. */
  ema: number;
  /** `ERC_s = EMA_s · R_s` — estimated remaining cost. */
  estimatedRemainingCost: number;
  /** `C_cum` — cumulative actual cost so far. */
  cumulativeCost: number;
  /** `C_proj = C_cum + ERC_s` — projected total cost for the run. */
  projectedCost: number;
  /** `B_limit` — the configured budget ceiling (currency's smallest unit). */
  budgetLimit: number;
  /** ISO 4217 currency code all amounts on this state are expressed in. */
  currency: string;
  /** `R_s = N_total − N_completed` — remaining steps. */
  remainingSteps: number;
  /** `N_total` — total planned milestones. */
  totalMilestones: number;
  /** `N_completed` — milestones marked complete. */
  completedMilestones: number;
  /** `Progress = N_completed / N_total` ∈ [0, 1]. */
  progress: number;
  /** `BBR_s` — budget burn rate; `0` when progress is `0`. */
  burnRate: number;
}

/** Aggregate Worth-it metrics, mirrored from the latest recorded step. */
export interface WorthItMetrics extends WorthItStepState {
  /** Number of steps recorded so far. */
  steps: number;
  /** Cumulative input (prompt) tokens across all recorded steps. */
  inputTokens: number;
  /** Cumulative output (completion) tokens across all recorded steps. */
  outputTokens: number;
}

/**
 * Developer-facing handle passed to {@link OnWorthItStep}. Lets the application
 * advance progress (the milestone-based `R_s`) and inspect live metrics while a
 * run is in flight, without exposing the engine's internal step recording.
 */
export interface WorthItControls {
  /** Mark `n` further milestones complete (default 1). */
  completeMilestone(n?: number): void;
  /** Set the absolute number of completed milestones. */
  setCompletedMilestones(n: number): void;
  /** Live metrics snapshot from the most recent step. */
  readonly metrics: WorthItMetrics;
}

/**
 * Per-step progress hook for `worth-it` mode used through `withCircuitBreaker`.
 * Invoked once per finished step — **before** that step is costed — so the
 * application can advance milestones based on what the step produced. Kept
 * synchronous: advancing progress is a quick local operation, and this keeps
 * the contract identical across callback- and generator-based adapters.
 *
 * `TStep` is the adapter's native finished-step object (e.g. a Vercel
 * `StepResult`, a Claude `SDKAssistantMessage`).
 */
export type OnWorthItStep<TStep = unknown> = (
  controls: WorthItControls,
  step: TStep,
) => void;

/**
 * Worth-it config as accepted by `withCircuitBreaker` — the engine config with
 * a required `mode: "worth-it"` discriminator so it slots into the wrapper's
 * mode union.
 */
export type WorthItWrapperConfig = Omit<WorthItConfig, "mode"> & {
  mode: "worth-it";
};

export type WrapperOptions<R = never, TInput = unknown> =
  CircuitBreakerOptions<TInput> & {
    /** Suppress the throw and use this return value instead. */
    onTrip?: OnTrip<R>;
  };

/**
 * The `worth-it` arm of an adapter's option union: the engine config plus the
 * wrapper-level `onTrip` / `onWorthItStep`. Adapters union this with their
 * classic {@link WrapperOptions} so `mode: "worth-it"` is accepted without
 * disturbing the `budget-guard` / `loop-killer` arms.
 */
export type WorthItWrapperOptions<R = never, TStep = unknown> =
  WorthItWrapperConfig & {
    onTrip?: OnTrip<R>;
    onWorthItStep?: OnWorthItStep<TStep>;
  };
