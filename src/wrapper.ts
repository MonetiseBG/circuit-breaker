import { CircuitBreakerCallback } from "./callback.js";
import { CircuitBreakerError } from "./errors.js";
import type { WrapperOptions } from "./types.js";

/**
 * Minimal structural type for a LangChain Runnable. We only depend on the
 * `invoke` shape so we don't force a specific LangChain version.
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
 * Wrap a LangChain Runnable (e.g. AgentExecutor) so its invocations are
 * cut off once the configured iteration or token limit is exceeded.
 *
 * Without `onTrip` the wrapper re-throws CircuitBreakerError. With `onTrip`
 * the error is suppressed and the callback's return value becomes the
 * wrapper's result; its return type is unioned into the wrapper output.
 */
export function withCircuitBreaker<TInput, TOutput>(
  runnable: RunnableLike<TInput, TOutput>,
  options: WrapperOptions<never>,
): WrappedRunnable<TInput, TOutput>;
export function withCircuitBreaker<TInput, TOutput, TFallback>(
  runnable: RunnableLike<TInput, TOutput>,
  options: WrapperOptions<TFallback>,
): WrappedRunnable<TInput, TOutput | TFallback>;
export function withCircuitBreaker<TInput, TOutput, TFallback>(
  runnable: RunnableLike<TInput, TOutput>,
  options: WrapperOptions<TFallback>,
): WrappedRunnable<TInput, TOutput | TFallback> {
  const { onTrip, ...callbackOpts } = options;

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
