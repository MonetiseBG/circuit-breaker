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
 */
export function withCircuitBreaker<TInput, TOutput, TFallback = never>(
  runnable: RunnableLike<TInput, TOutput>,
  options?: WrapperOptions<TFallback>,
): WrappedRunnable<TInput, TOutput | TFallback> {
  const callbackOpts: CircuitBreakerOptions = options
    ? stripOnTrip(options)
    : {};
  const onTrip = options?.onTrip;

  return {
    async invoke(input, config) {
      const breaker = new CircuitBreakerCallback(callbackOpts);
      const existing = (config?.callbacks as unknown[] | undefined) ?? [];
      const callbacks = [...existing, breaker];
      try {
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

function stripOnTrip<R>(opts: WrapperOptions<R>): CircuitBreakerOptions {
  const { onTrip: _onTrip, ...rest } = opts as WrapperOptions<R> & {
    onTrip?: unknown;
  };
  return rest as CircuitBreakerOptions;
}
