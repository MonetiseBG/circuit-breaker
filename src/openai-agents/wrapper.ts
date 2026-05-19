import { Runner } from "@openai/agents";
import type {
  Agent,
  AgentInputItem,
  NonStreamRunOptions,
  RunConfig,
  RunResult,
  RunState,
} from "@openai/agents";

import { CircuitBreaker } from "../core/breaker.js";
import { CircuitBreakerError } from "../core/errors.js";
import type {
  CircuitBreakerOptions,
  EstimateInputTokens,
  WrapperOptions,
} from "../core/types.js";

/**
 * Wrapper-specific options for the @openai/agents adapter. Extends the
 * generic {@link WrapperOptions} with `runConfig`, forwarded to the internal
 * Runner so callers can plug in their own model provider, tracing, etc.
 */
export type OpenAIAgentsWrapperOptions<
  TFallback = never,
  TAgent extends Agent<any, any> = Agent<any, any>,
  TContext = undefined,
> = WrapperOptions<TFallback, RunInput<TContext, TAgent>> & {
  /** Optional config forwarded to `new Runner(...)` for each invocation. */
  runConfig?: Partial<RunConfig>;
};

type RunInput<TContext, TAgent extends Agent<any, any>> =
  | string
  | AgentInputItem[]
  | RunState<TContext, TAgent>;

export interface WrappedAgent<
  TAgent extends Agent<any, any>,
  TFallback = never,
> {
  run<TContext = undefined>(
    input: RunInput<TContext, TAgent>,
    options?: NonStreamRunOptions<TContext, TAgent>,
  ): Promise<RunResult<TContext, TAgent> | TFallback>;
}

/**
 * Wrap an @openai/agents `Agent` so its runs are cut off when the configured
 * circuit-breaker mode trips.
 *
 * - Iterations are counted on each `agent_start` event (one per turn). For
 *   `loop-killer` mode the latest `turnInput` item is hashed as the state key.
 * - Tokens are read from the live `RunContext.usage` snapshot on each turn
 *   boundary (`agent_start` and `agent_end`).
 * - On trip, an internal AbortSignal is fired to cancel the in-flight run;
 *   any caller-supplied `signal` is chained so external aborts still work.
 *
 * Without `onTrip` the wrapper re-throws `CircuitBreakerError`. With `onTrip`,
 * the error is suppressed and the callback's return value becomes the result.
 *
 * Streaming mode (`stream: true`) is not yet supported; use the core
 * `CircuitBreaker` directly if you need it.
 */
export function withCircuitBreaker<
  TAgent extends Agent<any, any>,
  TFallback = never,
>(
  agent: TAgent,
  options?: OpenAIAgentsWrapperOptions<TFallback, TAgent>,
): WrappedAgent<TAgent, TFallback> {
  const opts = options ?? {};
  const onTrip = opts.onTrip;
  const runConfig = opts.runConfig;
  const estimate =
    opts.mode === "loop-killer"
      ? undefined
      : (opts.estimateInputTokens as
          | EstimateInputTokens<RunInput<any, TAgent>>
          | undefined);
  const breakerOpts = toBreakerOpts(opts);

  return {
    async run<TContext = undefined>(
      input: RunInput<TContext, TAgent>,
      runOptions?: NonStreamRunOptions<TContext, TAgent>,
    ): Promise<RunResult<TContext, TAgent> | TFallback> {
      const breaker = new CircuitBreaker(breakerOpts);
      const runner = new Runner(runConfig);
      const controller = new AbortController();
      let tripError: CircuitBreakerError | undefined;

      const userSignal = runOptions?.signal;
      if (userSignal) {
        if (userSignal.aborted) controller.abort();
        else
          userSignal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
      }

      const guard = (fn: () => void): void => {
        if (tripError) return;
        try {
          fn();
        } catch (err) {
          if (err instanceof CircuitBreakerError) {
            tripError = err;
            controller.abort();
          } else {
            // Defensive: a non-breaker exception in our own code path. Surface
            // it without aborting the run.
            throw err;
          }
        }
      };

      if (estimate) {
        try {
          const estimated = estimate(
            input as RunInput<TContext, TAgent>,
          );
          if (typeof estimated === "number") {
            breaker.checkInputEstimate(estimated);
          }
        } catch (err) {
          if (err instanceof CircuitBreakerError) {
            if (onTrip) return await onTrip(err.toContext());
            throw err;
          }
          throw err;
        }
      }

      runner.on("agent_start", (context, _agent, turnInput) => {
        guard(() => breaker.recordIteration(summariseTurnInput(turnInput)));
        guard(() =>
          breaker.setTokenSnapshot(
            context.usage.inputTokens,
            context.usage.outputTokens,
          ),
        );
      });
      runner.on("agent_end", (context) => {
        guard(() =>
          breaker.setTokenSnapshot(
            context.usage.inputTokens,
            context.usage.outputTokens,
          ),
        );
      });

      try {
        return (await runner.run(agent, input, {
          ...runOptions,
          signal: controller.signal,
        } as NonStreamRunOptions<TContext, TAgent>)) as RunResult<TContext, TAgent>;
      } catch (err) {
        if (tripError) {
          if (onTrip) return await onTrip(tripError.toContext());
          throw tripError;
        }
        throw err;
      }
    },
  };
}

function toBreakerOpts<R, TAgent extends Agent<any, any>>(
  opts: OpenAIAgentsWrapperOptions<R, TAgent>,
): CircuitBreakerOptions {
  if (opts.mode === "loop-killer") {
    const { onTrip: _onTrip, runConfig: _runConfig, ...rest } = opts;
    return rest;
  }
  const {
    onTrip: _onTrip,
    runConfig: _runConfig,
    estimateInputTokens: _est,
    ...rest
  } = opts;
  return rest;
}

function summariseTurnInput(turnInput: AgentInputItem[] | undefined): string | undefined {
  if (!turnInput || turnInput.length === 0) return undefined;
  const last = turnInput[turnInput.length - 1];
  if (last == null) return undefined;
  try {
    return JSON.stringify(last);
  } catch {
    return undefined;
  }
}
