import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

import { CircuitBreaker } from "../core/breaker.js";
import type { CircuitBreakerOptions, Metrics } from "../core/types.js";
import { extractTokens } from "./tokens.js";

/**
 * LangChain callback handler that drives a {@link CircuitBreaker}. Attach via
 * `config.callbacks` on a Runnable invocation, or use
 * {@link ../langchain/wrapper#withCircuitBreaker} for the convenience wrapper.
 *
 * For `loop-killer` mode the callback summarises each call (the last prompt or
 * last chat message) into a state key the breaker hashes for loop detection.
 *
 * Each instance is single-use: counters carry across the whole invocation. For
 * a fresh invocation, create a new instance (or call {@link reset}).
 */
export class CircuitBreakerCallback extends BaseCallbackHandler {
  override name = "CircuitBreakerCallback";

  private readonly breaker: CircuitBreaker;
  private readonly countedRuns = new Set<string>();

  constructor(opts: CircuitBreakerOptions = {}) {
    super();
    this.breaker = new CircuitBreaker(opts);
  }

  get metrics(): Metrics {
    return this.breaker.metrics;
  }

  /** Run a preflight input-token estimate; trips before any LLM call if it exceeds `maxInputToken`. */
  checkInputEstimate(estimatedInputTokens: number): void {
    this.breaker.checkInputEstimate(estimatedInputTokens);
  }

  reset(): void {
    this.breaker.reset();
    this.countedRuns.clear();
  }

  override async handleLLMStart(
    _llm: unknown,
    prompts: string[],
    runId: string,
  ): Promise<void> {
    this.countIteration(runId, prompts[prompts.length - 1]);
  }

  override async handleChatModelStart(
    _llm: unknown,
    messages: unknown,
    runId: string,
  ): Promise<void> {
    this.countIteration(runId, summariseLastMessage(messages));
  }

  override async handleLLMEnd(
    output: LLMResult,
    _runId?: string,
    _parentRunId?: string,
    _tags?: string[],
  ): Promise<void> {
    if (this.breaker.isTripped) return;
    const { input, output: out } = extractTokens(output);
    this.breaker.addTokens(input, out);
  }

  private countIteration(runId: string, stateKey: string | undefined): void {
    if (this.breaker.isTripped) return;
    // Newer LangChain versions may dispatch both handleLLMStart and
    // handleChatModelStart for the same call — dedupe defensively.
    if (this.countedRuns.has(runId)) return;
    this.countedRuns.add(runId);
    this.breaker.recordIteration(stateKey);
  }
}

/**
 * Reduce LangChain's `BaseMessage[][]` (or unknown shape) to a stable string
 * representing the latest message — what we hash for loop detection. Full
 * histories grow each turn and never collide, so we use only the most recent
 * item: when an agent is stuck calling the same tool, the most recent
 * observation passed into the next LLM call is identical across turns.
 */
function summariseLastMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const lastBatch = messages[messages.length - 1];
  if (!Array.isArray(lastBatch)) return undefined;
  const last = lastBatch[lastBatch.length - 1];
  if (last == null) return undefined;
  if (typeof last === "string") return last;
  if (typeof last === "object") {
    const content = isRecord(last) ? last["content"] : undefined;
    if (typeof content === "string") return content;
    try {
      return JSON.stringify(content ?? last);
    } catch {
      return undefined;
    }
  }
  return String(last);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
