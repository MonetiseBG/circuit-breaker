import {
  CircuitBreaker,
  CircuitBreakerError,
  createWorthItRunner,
  isWorthItConfig,
} from "../core/index.js";
import type {
  CircuitBreakerOptions,
  EstimateInputTokens,
  OnTrip,
  OnWorthItStep,
  WorthItRunner,
  WorthItWrapperConfig,
  WorthItWrapperOptions,
  WrapperOptions,
} from "../core/index.js";
import { extractTokens } from "./tokens.js";

/**
 * A single chunk yielded by `client.runs.stream(...)`. Kept structural (we only
 * read `event` + `data`) so the adapter doesn't bind to a specific
 * `@langchain/langgraph-sdk` version's stream-event union.
 */
export interface LangGraphStreamChunk {
  event: string;
  data: unknown;
  id?: string;
}

/** Subset of `RunsStreamPayload` the adapter reads or rewrites. */
export interface RunsStreamPayloadLike {
  input?: Record<string, unknown> | null;
  streamMode?: string | string[];
  signal?: AbortSignal;
  [key: string]: unknown;
}

/**
 * Structural type for `client.runs`. We need `stream` to drive the breaker and
 * the optional `cancel` to stop the run server-side on a trip — aborting the
 * local stream only closes the SSE connection; the deployed graph keeps
 * burning tokens unless the run itself is cancelled.
 */
export interface RunsLike {
  stream(
    threadId: string | null,
    assistantId: string,
    payload?: RunsStreamPayloadLike,
  ): AsyncIterable<LangGraphStreamChunk>;
  cancel?(
    threadId: string,
    runId: string,
    wait?: boolean,
    action?: "interrupt" | "rollback",
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

/** The `(threadId, assistantId, payload)` triple a single stream is started with. */
export interface LangGraphStreamArgs {
  threadId: string | null;
  assistantId: string;
  payload?: RunsStreamPayloadLike;
}

/**
 * Wrapper-specific options for the `@langchain/langgraph-sdk` adapter. The
 * optional preflight `estimateInputTokens` receives the
 * {@link LangGraphStreamArgs} the wrapped `stream` was called with.
 */
export type LangGraphSdkWrapperOptions<TFallback = never> =
  | WrapperOptions<TFallback, LangGraphStreamArgs>
  | WorthItWrapperOptions<TFallback, LangGraphStreamChunk>;

export interface WrappedRuns<TFallback = never> {
  stream(
    threadId: string | null,
    assistantId: string,
    payload?: RunsStreamPayloadLike,
  ): AsyncGenerator<LangGraphStreamChunk | TFallback, void>;
}

/**
 * Wrap a LangGraph Platform `client.runs` so each streamed run is cut off when
 * the configured circuit-breaker mode trips.
 *
 * The breaker is driven off the `events` stream mode (the only mode that
 * surfaces both per-LLM-call boundaries and token usage). The adapter forces
 * `events` into the run's `streamMode`; if the caller didn't ask for it, the
 * injected `events` chunks are consumed internally and not yielded, so the
 * caller's stream is unchanged.
 *
 * - Iterations are counted on each `on_chat_model_start` / `on_llm_start`
 *   event. For `loop-killer` mode the latest input message is hashed as the
 *   state key — a stuck agent re-sends the same observation each turn.
 * - Tokens are read from each `on_chat_model_end` / `on_llm_end` event's
 *   `usage_metadata` (see {@link extractTokens}).
 * - On trip, an internal `AbortSignal` closes the local stream and, when
 *   `runs.cancel` is available and the `metadata` event has reported the
 *   run/thread ids, the run is cancelled server-side (best-effort). Any
 *   caller-supplied `payload.signal` is chained so external aborts still work.
 *
 * Without `onTrip` the generator throws `CircuitBreakerError` once a limit is
 * hit. With `onTrip`, the throw is suppressed and the callback's return value
 * is yielded as the final item before the generator ends.
 */
export function withCircuitBreaker<TFallback = never>(
  runs: RunsLike,
  options?: LangGraphSdkWrapperOptions<TFallback>,
): WrappedRuns<TFallback> {
  const opts = options ?? {};
  const onTrip = opts.onTrip;

  if (isWorthItConfig(opts)) {
    const worthItOpts = opts;
    const onWorthItStep = opts.onWorthItStep;
    return {
      stream(threadId, assistantId, payload) {
        return runStreamWorthIt(
          runs,
          { threadId, assistantId, payload },
          worthItOpts,
          onWorthItStep,
          onTrip,
        );
      },
    };
  }

  const estimate =
    opts.mode === "loop-killer" ? undefined : opts.estimateInputTokens;
  const breakerOpts = toBreakerOpts(opts);

  return {
    stream(threadId, assistantId, payload) {
      return runStream(
        runs,
        { threadId, assistantId, payload },
        breakerOpts,
        onTrip,
        estimate,
      );
    },
  };
}

async function* runStreamWorthIt<TFallback>(
  runs: RunsLike,
  args: LangGraphStreamArgs,
  worthItOpts: WorthItWrapperConfig,
  onWorthItStep: OnWorthItStep<LangGraphStreamChunk> | undefined,
  onTrip: OnTrip<TFallback> | undefined,
): AsyncGenerator<LangGraphStreamChunk | TFallback, void> {
  const runner = createWorthItRunner(worthItOpts, onWorthItStep);

  const { threadId, assistantId, payload } = args;
  const userModes = normaliseModes(payload?.streamMode);
  const injectedEvents = !userModes.includes("events");
  const streamMode = injectedEvents ? [...userModes, "events"] : userModes;

  const controller = new AbortController();
  const userSignal = payload?.signal;
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else
      userSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  const stream = runs.stream(threadId, assistantId, {
    ...payload,
    streamMode,
    signal: controller.signal,
  });

  let tripError: CircuitBreakerError | undefined;
  let runId: string | undefined;
  let runThreadId = typeof threadId === "string" ? threadId : undefined;

  try {
    for await (const chunk of stream) {
      if (chunk.event === "metadata") {
        const meta = isRecord(chunk.data) ? chunk.data : undefined;
        if (typeof meta?.["run_id"] === "string") runId = meta["run_id"];
        if (typeof meta?.["thread_id"] === "string")
          runThreadId = meta["thread_id"];
      }

      if (!(injectedEvents && isEventsChunk(chunk))) yield chunk;

      try {
        driveWorthIt(runner, chunk);
      } catch (err) {
        if (err instanceof CircuitBreakerError) {
          tripError = err;
          controller.abort();
          await cancelRun(runs, runThreadId, runId);
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

function driveWorthIt(
  runner: WorthItRunner<LangGraphStreamChunk>,
  chunk: LangGraphStreamChunk,
): void {
  if (!isEventsChunk(chunk)) return;
  const event = chunk.data;
  if (!isRecord(event)) return;

  const name = event["event"];
  if (name !== "on_chat_model_end" && name !== "on_llm_end") return;
  const inner = isRecord(event["data"]) ? event["data"] : undefined;
  const { input, output } = extractTokens(inner?.["output"]);
  runner.recordStep({ input, output, model: modelFromEvent(inner) }, chunk);
}

/** Best-effort model id from a chat-model end event; else `defaultPricing`. */
function modelFromEvent(inner: Record<string, unknown> | undefined): string | undefined {
  const output = inner?.["output"];
  if (isRecord(output)) {
    const meta = output["response_metadata"];
    if (isRecord(meta)) {
      const name = meta["model_name"] ?? meta["model"] ?? meta["ls_model_name"];
      if (typeof name === "string") return name;
    }
  }
  const metadata = isRecord(inner?.["metadata"]) ? inner["metadata"] : undefined;
  const lsModel = metadata?.["ls_model_name"];
  return typeof lsModel === "string" ? lsModel : undefined;
}

async function* runStream<TFallback>(
  runs: RunsLike,
  args: LangGraphStreamArgs,
  breakerOpts: CircuitBreakerOptions,
  onTrip: OnTrip<TFallback> | undefined,
  estimate: EstimateInputTokens<LangGraphStreamArgs> | undefined,
): AsyncGenerator<LangGraphStreamChunk | TFallback, void> {
  const breaker = new CircuitBreaker(breakerOpts);

  if (estimate) {
    try {
      const estimated = estimate(args);
      if (typeof estimated === "number") breaker.checkInputEstimate(estimated);
    } catch (err) {
      if (err instanceof CircuitBreakerError && onTrip) {
        yield await onTrip(err.toContext());
        return;
      }
      throw err;
    }
  }

  const { threadId, assistantId, payload } = args;
  const userModes = normaliseModes(payload?.streamMode);
  const injectedEvents = !userModes.includes("events");
  const streamMode = injectedEvents ? [...userModes, "events"] : userModes;

  const controller = new AbortController();
  const userSignal = payload?.signal;
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else
      userSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  const stream = runs.stream(threadId, assistantId, {
    ...payload,
    streamMode,
    signal: controller.signal,
  });

  let tripError: CircuitBreakerError | undefined;
  let runId: string | undefined;
  let runThreadId = typeof threadId === "string" ? threadId : undefined;

  try {
    for await (const chunk of stream) {
      if (chunk.event === "metadata") {
        const meta = isRecord(chunk.data) ? chunk.data : undefined;
        if (typeof meta?.["run_id"] === "string") runId = meta["run_id"];
        if (typeof meta?.["thread_id"] === "string")
          runThreadId = meta["thread_id"];
      }

      if (!(injectedEvents && isEventsChunk(chunk))) yield chunk;

      try {
        drive(breaker, chunk);
      } catch (err) {
        if (err instanceof CircuitBreakerError) {
          tripError = err;
          controller.abort();
          await cancelRun(runs, runThreadId, runId);
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

function drive(breaker: CircuitBreaker, chunk: LangGraphStreamChunk): void {
  if (breaker.isTripped) return;
  if (!isEventsChunk(chunk)) return;
  const event = chunk.data;
  if (!isRecord(event)) return;

  const name = event["event"];
  const inner = isRecord(event["data"]) ? event["data"] : undefined;

  if (name === "on_chat_model_start" || name === "on_llm_start") {
    breaker.recordIteration(summariseModelInput(inner?.["input"]));
    return;
  }
  if (name === "on_chat_model_end" || name === "on_llm_end") {
    const { input, output } = extractTokens(inner?.["output"]);
    breaker.addTokens(input, output);
  }
}

async function cancelRun(
  runs: RunsLike,
  threadId: string | undefined,
  runId: string | undefined,
): Promise<void> {
  if (!runs.cancel || !threadId || !runId) return;
  try {
    await runs.cancel(threadId, runId);
  } catch {
    // Best-effort: the local stream is already aborted. A failed server-side
    // cancel must not mask the CircuitBreakerError we're about to surface.
  }
}

/** A top-level `events` chunk, or a subgraph one (`"events|<namespace>"`). */
function isEventsChunk(chunk: LangGraphStreamChunk): boolean {
  return chunk.event === "events" || chunk.event.startsWith("events|");
}

function normaliseModes(mode: string | string[] | undefined): string[] {
  if (mode === undefined) return ["values"];
  return Array.isArray(mode) ? [...mode] : [mode];
}

/**
 * Reduce a chat model's `input` to a stable string for the latest message —
 * what we hash for loop detection. Full histories grow each turn and never
 * collide, so we key off only the most recent message: a stuck agent re-sends
 * the same observation into the next call.
 */
function summariseModelInput(input: unknown): string | undefined {
  const messages = pickMessages(input);
  if (!messages || messages.length === 0) return undefined;
  const last = messages[messages.length - 1];
  if (last == null) return undefined;
  if (typeof last === "string") return last;
  if (isRecord(last)) {
    const content = last["content"];
    if (typeof content === "string") return content;
    try {
      return JSON.stringify(content ?? last);
    } catch {
      return undefined;
    }
  }
  return String(last);
}

function pickMessages(input: unknown): unknown[] | undefined {
  if (Array.isArray(input)) {
    // `messages` can arrive nested one level (BaseMessage[][]).
    const flat = input.length === 1 && Array.isArray(input[0]) ? input[0] : input;
    return flat as unknown[];
  }
  if (isRecord(input) && Array.isArray(input["messages"])) {
    return pickMessages(input["messages"]);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBreakerOpts<R>(
  opts: WrapperOptions<R, LangGraphStreamArgs>,
): CircuitBreakerOptions {
  if (opts.mode === "loop-killer") {
    const { onTrip: _onTrip, ...rest } = opts;
    return rest;
  }
  const { onTrip: _onTrip, estimateInputTokens: _est, ...rest } = opts;
  return rest;
}
