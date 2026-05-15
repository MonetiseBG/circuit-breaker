import { CircuitBreakerError } from "../core/errors.js";
import type {
  CircuitBreakerOptions,
  EstimateInputTokens,
  WrapperOptions,
} from "../core/types.js";
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
export function withCircuitBreaker<TInput, TOutput, TFallback = never>(
  runnable: RunnableLike<TInput, TOutput>,
  options?: WrapperOptions<TFallback, TInput>,
): WrappedRunnable<TInput, TOutput | TFallback> {
  const callbackOpts = stripWrapperOnly(options);
  const onTrip = options?.onTrip;
  const estimate = pickEstimator(options);

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

function stripWrapperOnly<R, TInput>(
  opts: WrapperOptions<R, TInput> | undefined,
): CircuitBreakerOptions {
  if (!opts) return {};
  const {
    onTrip: _onTrip,
    estimateInputTokens: _estimate,
    ...rest
  } = opts as WrapperOptions<R, TInput> & {
    onTrip?: unknown;
    estimateInputTokens?: unknown;
  };
  return rest as CircuitBreakerOptions;
}

function pickEstimator<R, TInput>(
  opts: WrapperOptions<R, TInput> | undefined,
): EstimateInputTokens<TInput> | undefined {
  if (!opts || opts.mode === "loop-killer") return undefined;
  return opts.estimateInputTokens;
}
