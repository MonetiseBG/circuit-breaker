import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

import { CircuitBreaker } from "../core/breaker.js";
import type { CircuitBreakerOptions, Metrics } from "../core/types.js";
import { extractTokens } from "./tokens.js";

/**
 * LangChain callback handler that counts LLM iterations and token usage and
 * trips (throws a CircuitBreakerError) once either configured limit is
 * exceeded. Attach via `config.callbacks` on a Runnable invocation, or use
 * {@link ../langchain/wrapper#withCircuitBreaker} for the convenience wrapper.
 *
 * Each instance is single-use: counters carry across the whole invocation.
 * For a fresh invocation, create a new instance (or call {@link reset}).
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

  reset(): void {
    this.breaker.reset();
    this.countedRuns.clear();
  }

  override async handleLLMStart(
    _llm: unknown,
    _prompts: string[],
    runId: string,
  ): Promise<void> {
    this.countIteration(runId);
  }

  override async handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    runId: string,
  ): Promise<void> {
    this.countIteration(runId);
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

  private countIteration(runId: string): void {
    if (this.breaker.isTripped) return;
    // Newer LangChain versions may dispatch both handleLLMStart and
    // handleChatModelStart for the same call — dedupe defensively.
    if (this.countedRuns.has(runId)) return;
    this.countedRuns.add(runId);
    this.breaker.recordIteration();
  }
}
