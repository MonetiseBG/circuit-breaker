import type { LLMResult } from "@langchain/core/outputs";
import type { RunnableConfig } from "@langchain/core/runnables";

import { CircuitBreakerError, isWorthItConfig } from "../core/index.js";
import type {
  CircuitBreakerOptions,
  WorthItWrapperOptions,
  WrapperOptions,
} from "../core/index.js";
import { CircuitBreakerCallback, WorthItCallback } from "./callback.js";

/**
 * Minimal structural type for a LangChain Runnable. We only depend on the
 * `invoke` shape so we don't bind to a specific LangChain version.
 */
export interface RunnableLike<TInput, TOutput> {
  invoke(input: TInput, config?: RunnableConfig): Promise<TOutput>;
}

/**
 * Options for the LangChain wrapper: the classic {@link WrapperOptions} or the
 * `worth-it` arm, whose `onWorthItStep` receives each {@link LLMResult}.
 */
export type LangChainWrapperOptions<R = never, TInput = unknown> =
  | WrapperOptions<R, TInput>
  | WorthItWrapperOptions<R, LLMResult>;

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
  options?: LangChainWrapperOptions<TFallback, TInput>,
): RunnableLike<TInput, TOutput | TFallback> {
  const opts = options ?? {};
  const onTrip = opts.onTrip;

  if (isWorthItConfig(opts)) {
    const worthItOpts = opts;
    const onWorthItStep = opts.onWorthItStep;
    return {
      async invoke(input, config) {
        const cb = new WorthItCallback(worthItOpts, onWorthItStep);
        const existing = config?.callbacks ?? [];
        const callbacks = [
          ...(Array.isArray(existing) ? existing : [existing]),
          cb,
        ];
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

  const estimate = opts.mode === "loop-killer" ? undefined : opts.estimateInputTokens;
  const callbackOpts = toBreakerOpts(opts);

  return {
    async invoke(input, config) {
      const breaker = new CircuitBreakerCallback(callbackOpts);
      const existing = config?.callbacks ?? [];
      const callbacks = [
        ...(Array.isArray(existing) ? existing : [existing]),
        breaker,
      ];
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
