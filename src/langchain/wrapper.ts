import { CircuitBreakerError } from "../core/errors.js";
import type { CircuitBreakerOptions, WrapperOptions } from "../core/types.js";
import { CircuitBreakerCallback } from "./callback.js";

/**
 * Minimal structural type for a LangChain Runnable. We only depend on the
 * `invoke` shape so we don't bind to a specific LangChain version.
 */
interface RunnableLike<TInput, TOutput> {
  invoke(input: TInput, config?: InvokeConfig): Promise<TOutput>;
}

interface InvokeConfig {
  callbacks?: unknown[];
  [key: string]: unknown;
}

export interface WrappedRunnable<TInput, TOutput> {
  invoke(input: TInput, config?: InvokeConfig): Promise<TOutput>;
}

/**
 * Wrap a LangChain Runnable (e.g. `AgentExecutor`) so its invocations are cut
 * off when the configured circuit-breaker mode trips.
 *
 * Without an `options` argument the wrapper applies the `budget-guard` defaults
 * (10k input + 10k output tokens). Without `onTrip` the wrapper re-throws
 * `CircuitBreakerError`; with `onTrip` the error is suppressed and the
 * callback's return value becomes the wrapper's result.
 *
 * If `estimateInputTokens` is supplied the wrapper runs it on the `invoke`
 * input before calling the runnable; an oversized prompt trips the breaker
 * preflight so the runnable is never invoked.
 */
function toBreakerOpts<R, TInput>(
  opts: WrapperOptions<R, TInput>,
): CircuitBreakerOptions {
  if (opts.mode === "loop-killer") {
    const { onTrip: _onTrip, ...rest } = opts;
    return rest;
  }
  const { onTrip: _onTrip, estimateInputTokens: _est, ...rest } = opts;
  return rest;
}

export function withCircuitBreaker<TInput, TOutput, TFallback = never>(
  runnable: RunnableLike<TInput, TOutput>,
  options?: WrapperOptions<TFallback, TInput>,
): WrappedRunnable<TInput, TOutput | TFallback> {
  const opts = options ?? {};
  const onTrip = opts.onTrip;
  const estimate = opts.mode === "loop-killer" ? undefined : opts.estimateInputTokens;
  const callbackOpts = toBreakerOpts(opts);

  return {
    async invoke(input, config) {
      const breaker = new CircuitBreakerCallback(callbackOpts);
      const existing = (config?.callbacks as unknown[] | undefined) ?? [];
      const callbacks = [...existing, breaker];
      try {
        if (estimate) {
          const estimated = estimate(input);
          if (typeof estimated === "number") {
            breaker.checkInputEstimate(estimated);
          }
        }
        return await runnable.invoke(input, { ...config, callbacks });
      } catch (err) {
        if (err instanceof CircuitBreakerError && onTrip) {
          return await onTrip(err.toContext());
        }
        throw err;
      }
    },
  };
}
