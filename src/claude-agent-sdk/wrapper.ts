import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { CircuitBreaker } from "../core/breaker.js";
import { CircuitBreakerError } from "../core/errors.js";
import type {
  CircuitBreakerOptions,
  EstimateInputTokens,
  OnTrip,
  WrapperOptions,
} from "../core/types.js";

/**
 * Wrapper-specific options for the `@anthropic-ai/claude-agent-sdk` adapter.
 * The optional preflight `estimateInputTokens` receives the `QueryParams`
 * passed to the wrapped function.
 */
export type ClaudeAgentSdkWrapperOptions<TFallback = never> =
  WrapperOptions<TFallback, QueryParams>;

/** The argument shape of the SDK's `query` function. */
export interface QueryParams {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}

/**
 * Structural type for the SDK's `query` export. Kept loose (returns
 * `AsyncIterable`, not the full `Query` interface) so the adapter doesn't bind
 * to a specific SDK version's control-method surface.
 */
export type QueryFn = (params: QueryParams) => AsyncIterable<SDKMessage>;

export interface WrappedQuery<TFallback = never> {
  (params: QueryParams): AsyncGenerator<SDKMessage | TFallback, void>;
}

/**
 * Wrap the Claude Agent SDK's `query` function so each run is cut off when the
 * configured circuit-breaker mode trips.
 *
 * - Iterations are counted on each `assistant` message (one per turn). For
 *   `loop-killer` mode the assistant message's content blocks are hashed as the
 *   state key — a stuck agent repeats the same tool call, so the same content
 *   recurs across turns.
 * - Tokens are read from each `assistant` message's `usage` (per-turn deltas):
 *   input = `input_tokens` + cache read + cache creation, output = `output_tokens`.
 * - On trip, an internal `AbortController` is fired to cancel the in-flight
 *   query; any caller-supplied `options.abortController` is chained so external
 *   aborts still work.
 *
 * The wrapped function is itself an async generator: messages stream through
 * untouched. Without `onTrip` the generator throws `CircuitBreakerError` once a
 * limit is hit. With `onTrip`, the throw is suppressed and the callback's
 * return value is yielded as the final item before the generator ends.
 */
export function withCircuitBreaker<TFallback = never>(
  query: QueryFn,
  options?: ClaudeAgentSdkWrapperOptions<TFallback>,
): WrappedQuery<TFallback> {
  const onTrip = options?.onTrip;
  const breakerOpts: CircuitBreakerOptions = stripWrapperOnly(options);
  const estimate = pickEstimator(options);

  return function wrappedQuery(params: QueryParams) {
    return runWithBreaker(query, params, breakerOpts, onTrip, estimate);
  };
}

async function* runWithBreaker<TFallback>(
  query: QueryFn,
  params: QueryParams,
  breakerOpts: CircuitBreakerOptions,
  onTrip: OnTrip<TFallback> | undefined,
  estimate: EstimateInputTokens<QueryParams> | undefined,
): AsyncGenerator<SDKMessage | TFallback, void> {
  const breaker = new CircuitBreaker(breakerOpts);

  if (estimate) {
    try {
      const estimated = estimate(params);
      if (typeof estimated === "number") {
        breaker.checkInputEstimate(estimated);
      }
    } catch (err) {
      if (err instanceof CircuitBreakerError) {
        if (onTrip) {
          yield await onTrip(err.toContext());
          return;
        }
        throw err;
      }
      throw err;
    }
  }

  const controller = new AbortController();
  const userController = params.options?.abortController;
  if (userController) {
    if (userController.signal.aborted) controller.abort();
    else
      userController.signal.addEventListener(
        "abort",
        () => controller.abort(),
        { once: true },
      );
  }

  const stream = query({
    ...params,
    options: { ...params.options, abortController: controller },
  });

  let tripError: CircuitBreakerError | undefined;

  try {
    for await (const message of stream) {
      yield message;
      try {
        drive(breaker, message);
      } catch (err) {
        if (err instanceof CircuitBreakerError) {
          tripError = err;
          controller.abort();
          break;
        }
        throw err;
      }
    }
  } catch (err) {
    if (tripError === undefined) throw err;
  }

  if (tripError) {
    if (onTrip) {
      yield await onTrip(tripError.toContext());
      return;
    }
    throw tripError;
  }
}

function drive(breaker: CircuitBreaker, message: SDKMessage): void {
  if (message.type !== "assistant") return;
  breaker.recordIteration(summariseAssistant(message));
  const usage = message.message.usage;
  if (usage) {
    breaker.addTokens(inputTokens(usage), usage.output_tokens ?? 0);
  }
}

type AssistantUsage = SDKAssistantMessage["message"]["usage"];

function inputTokens(usage: AssistantUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function summariseAssistant(message: SDKAssistantMessage): string | undefined {
  const content = message.message?.content;
  if (content == null) return undefined;
  try {
    return JSON.stringify(content);
  } catch {
    return undefined;
  }
}

function stripWrapperOnly<R>(
  opts: ClaudeAgentSdkWrapperOptions<R> | undefined,
): CircuitBreakerOptions {
  if (!opts) return {};
  const {
    onTrip: _onTrip,
    estimateInputTokens: _estimate,
    ...rest
  } = opts as ClaudeAgentSdkWrapperOptions<R> & {
    onTrip?: unknown;
    estimateInputTokens?: unknown;
  };
  return rest as CircuitBreakerOptions;
}

function pickEstimator<R>(
  opts: ClaudeAgentSdkWrapperOptions<R> | undefined,
): EstimateInputTokens<QueryParams> | undefined {
  if (!opts || opts.mode === "loop-killer") return undefined;
  return opts.estimateInputTokens;
}
