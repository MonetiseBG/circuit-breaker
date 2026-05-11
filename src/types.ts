export type TripReason = "max_iterations" | "max_tokens";

export interface TokenMetrics {
  input: number;
  output: number;
  total: number;
}

export interface Metrics {
  iterations: number;
  tokens: TokenMetrics;
}

export interface Limits {
  maxIterations?: number;
  maxTokens?: number;
}

export interface TripContext {
  reason: TripReason;
  metrics: Metrics;
  limits: Limits;
  message: string;
}

export type Logger = (message: string, context: TripContext) => void;

export interface CircuitBreakerOptions extends Limits {
  /** Suppress the default console.warn log when the breaker trips. */
  silent?: boolean;
  /** Custom logger. Defaults to console.warn. Ignored when `silent: true`. */
  logger?: Logger;
}

export type OnTrip<R> = (context: TripContext) => R | Promise<R>;

export interface WrapperOptions<TFallback = never> extends CircuitBreakerOptions {
  /**
   * Called when the circuit trips. If provided, the wrapper suppresses the
   * CircuitBreakerError and the value returned by `onTrip` becomes the
   * wrapper's result.
   */
  onTrip?: OnTrip<TFallback>;
}
