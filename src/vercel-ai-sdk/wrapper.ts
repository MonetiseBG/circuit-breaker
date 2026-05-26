import type { StepResult, ToolSet, generateText as GenerateText } from "ai";

import { CircuitBreaker, CircuitBreakerError } from "../core/index.js";
import type {
  CircuitBreakerOptions,
  EstimateInputTokens,
  OnTrip,
  WrapperOptions,
} from "../core/index.js";
import { extractTokens } from "./tokens.js";

/**
 * The {@link https://ai-sdk.dev | AI SDK}'s `generateText` function. Kept as a
 * `typeof` reference (type-only) so the adapter binds structurally and carries
 * no runtime dependency on the optional `ai` peer.
 */
export type GenerateTextFn = typeof GenerateText;

/** The single options argument `generateText` is called with. */
export type GenerateTextOptions = Parameters<GenerateTextFn>[0];

/** The resolved `GenerateTextResult` a `generateText` call produces. */
export type GenerateTextOutput = Awaited<ReturnType<GenerateTextFn>>;

/**
 * Wrapper-specific options for the `ai` (Vercel AI SDK) adapter. The optional
 * preflight `estimateInputTokens` receives the {@link GenerateTextOptions} the
 * wrapped `generateText` was called with.
 */
export type VercelAiSdkWrapperOptions<TFallback = never> = WrapperOptions<
  TFallback,
  GenerateTextOptions
>;

export interface WrappedGenerateText<TFallback = never> {
  (options: GenerateTextOptions): Promise<GenerateTextOutput | TFallback>;
}

/**
 * Wrap the AI SDK's `generateText` so each call's internal tool-loop is cut off
 * when the configured circuit-breaker mode trips.
 *
 * - Iterations are counted on each finished step (one per LLM call) via the
 *   injected `onStepFinish`. For `loop-killer` mode the step's tool calls (or
 *   its text, as a fallback) are hashed as the state key — a stuck agent
 *   re-issues the same tool call each step.
 * - Tokens are read from each step's `usage` as per-call deltas (see
 *   {@link extractTokens}).
 * - On trip, an internal `AbortSignal` cancels the in-flight loop before the
 *   next LLM call; any caller-supplied `abortSignal` is chained so external
 *   aborts still work. If the loop finishes on the same step that tripped (no
 *   further call to abort), the trip is still surfaced after the call returns.
 *
 * Any caller-supplied `onStepFinish` is invoked first, then the breaker is
 * driven — so the caller's callback always sees every step. `stopWhen`,
 * `tools`, `prepareStep`, and the rest of the options pass through untouched.
 *
 * Without `onTrip` the wrapper re-throws `CircuitBreakerError`. With `onTrip`,
 * the error is suppressed and the callback's return value becomes the result.
 *
 * Streaming (`streamText`) is not yet supported; use the core `CircuitBreaker`
 * directly if you need it.
 */
export function withCircuitBreaker<TFallback = never>(
  generate: GenerateTextFn,
  options?: VercelAiSdkWrapperOptions<TFallback>,
): WrappedGenerateText<TFallback> {
  const opts = options ?? {};
  const onTrip = opts.onTrip;
  const estimate =
    opts.mode === "loop-killer" ? undefined : opts.estimateInputTokens;
  const breakerOpts = toBreakerOpts(opts);

  return (genOptions: GenerateTextOptions) =>
    runWithBreaker(generate, genOptions, breakerOpts, onTrip, estimate);
}

async function runWithBreaker<TFallback>(
  generate: GenerateTextFn,
  genOptions: GenerateTextOptions,
  breakerOpts: CircuitBreakerOptions,
  onTrip: OnTrip<TFallback> | undefined,
  estimate: EstimateInputTokens<GenerateTextOptions> | undefined,
): Promise<GenerateTextOutput | TFallback> {
  const breaker = new CircuitBreaker(breakerOpts);

  if (estimate) {
    try {
      const estimated = estimate(genOptions);
      if (typeof estimated === "number") breaker.checkInputEstimate(estimated);
    } catch (err) {
      if (err instanceof CircuitBreakerError && onTrip) {
        return await onTrip(err.toContext());
      }
      throw err;
    }
  }

  const controller = new AbortController();
  const userSignal = genOptions.abortSignal;
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else
      userSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  let tripError: CircuitBreakerError | undefined;
  const userOnStepFinish = genOptions.onStepFinish;

  const onStepFinish = async (step: StepResult<ToolSet>): Promise<void> => {
    if (userOnStepFinish) await userOnStepFinish(step);
    if (tripError) return;
    try {
      breaker.recordIteration(summariseStep(step));
      const { input, output } = extractTokens(step.usage);
      breaker.addTokens(input, output);
    } catch (err) {
      if (err instanceof CircuitBreakerError) {
        tripError = err;
        controller.abort();
        return;
      }
      throw err;
    }
  };

  try {
    const result = await generate({
      ...genOptions,
      abortSignal: controller.signal,
      onStepFinish,
    });
    return tripError ? handleTrip(tripError, onTrip) : result;
  } catch (err) {
    if (tripError) return handleTrip(tripError, onTrip);
    throw err;
  }
}

function handleTrip<TFallback>(
  tripError: CircuitBreakerError,
  onTrip: OnTrip<TFallback> | undefined,
): Promise<TFallback> {
  if (onTrip) return Promise.resolve(onTrip(tripError.toContext()));
  throw tripError;
}

/**
 * Reduce a finished step to a stable string for loop detection. A stuck agent
 * re-issues the same tool call each step, so the tool calls are the strongest
 * signal; fall back to the step's text, then its raw content.
 */
function summariseStep(step: StepResult<ToolSet>): string | undefined {
  if (step.toolCalls && step.toolCalls.length > 0) {
    try {
      return JSON.stringify(step.toolCalls);
    } catch {
      // fall through to text / content
    }
  }
  if (typeof step.text === "string" && step.text.length > 0) return step.text;
  try {
    return JSON.stringify(step.content);
  } catch {
    return undefined;
  }
}

function toBreakerOpts<R>(opts: VercelAiSdkWrapperOptions<R>): CircuitBreakerOptions {
  if (opts.mode === "loop-killer") {
    const { onTrip: _onTrip, ...rest } = opts;
    return rest;
  }
  const { onTrip: _onTrip, estimateInputTokens: _est, ...rest } = opts;
  return rest;
}
