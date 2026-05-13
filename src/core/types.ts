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

export interface BudgetGuardConfig {
  mode?: "budget-guard";
  /** Maximum aggregate input tokens. Default: 10_000. */
  maxInputToken?: number;
  /** Maximum aggregate output tokens. Default: 10_000. */
  maxOutputToken?: number;
}

export interface LoopKillerConfig {
  mode: "loop-killer";
  /** Max times any single state may repeat (or, with detectRepeatedState=false,
   *  max raw iterations) before tripping. Default: 3. */
  maxRetries?: number;
  /** Hash each step's state to detect loops. Default: true. */
  detectRepeatedState?: boolean;
}

export type ModeConfig = BudgetGuardConfig | LoopKillerConfig;

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

export type CircuitBreakerOptions = ModeConfig & CommonConfig;

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

export type WrapperOptions<R = never> = CircuitBreakerOptions & {
  /** Suppress the throw and use this return value instead. */
  onTrip?: OnTrip<R>;
};
