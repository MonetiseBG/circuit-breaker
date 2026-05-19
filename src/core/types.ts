export type Mode = "budget-guard" | "loop-killer";

export type StopReason =
  | "max_input_tokens"
  | "max_output_tokens"
  | "max_retries"
  | "repeated_state";

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

export type CircuitBreakerEvent =
  | { type: "retry"; retries: number }
  | { type: "stop"; reason: StopReason; saved: number };

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
   * - loop-killer:  `maxRetries - max(retries, iterations)`.
   *
   * Negative values mean we tripped after overshooting the limit (the call
   * that pushed us over still counts).
   */
  saved: number;
  message: string;
}

export type OnTrip<R> = (context: TripContext) => R | Promise<R>;

export type WrapperOptions<R = never, TInput = unknown> =
  CircuitBreakerOptions<TInput> & {
    /** Suppress the throw and use this return value instead. */
    onTrip?: OnTrip<R>;
  };
