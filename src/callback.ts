import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

import { CircuitBreakerError } from "./errors.js";
import { defaultLogger } from "./logger.js";
import { extractTokens } from "./tokens.js";
import type {
  CircuitBreakerOptions,
  Logger,
  Metrics,
  TripContext,
  TripReason,
} from "./types.js";

/**
 * LangChain callback handler that counts LLM iterations and token usage and
 * trips (throws a CircuitBreakerError) once either configured limit is
 * exceeded. Attach it via `config.callbacks` on a Runnable invocation, or
 * use {@link withCircuitBreaker} for the convenience wrapper.
 *
 * Each instance is single-use: counters carry across the whole invocation.
 * For a fresh invocation, create a new instance (or call {@link reset}).
 */
export class CircuitBreakerCallback extends BaseCallbackHandler {
  override name = "CircuitBreakerCallback";

  private readonly maxIterations?: number;
  private readonly maxTokens?: number;
  private readonly silent: boolean;
  private readonly logger: Logger;

  private iterations = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private tripped = false;
  private readonly countedRuns = new Set<string>();

  constructor(opts: CircuitBreakerOptions = {}) {
    super();
    if (opts.maxIterations !== undefined && (!Number.isFinite(opts.maxIterations) || opts.maxIterations < 1)) {
      throw new TypeError("maxIterations must be a finite number >= 1");
    }
    if (opts.maxTokens !== undefined && (!Number.isFinite(opts.maxTokens) || opts.maxTokens < 1)) {
      throw new TypeError("maxTokens must be a finite number >= 1");
    }
    if (opts.maxIterations === undefined && opts.maxTokens === undefined) {
      throw new TypeError("CircuitBreakerCallback requires at least one of maxIterations or maxTokens");
    }
    this.maxIterations = opts.maxIterations;
    this.maxTokens = opts.maxTokens;
    this.silent = opts.silent ?? false;
    this.logger = opts.logger ?? defaultLogger;
  }

  get metrics(): Metrics {
    return {
      iterations: this.iterations,
      tokens: {
        input: this.inputTokens,
        output: this.outputTokens,
        total: this.inputTokens + this.outputTokens,
      },
    };
  }

  reset(): void {
    this.iterations = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.tripped = false;
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
    if (this.tripped) return;
    const { input, output: out } = extractTokens(output);
    this.inputTokens += input;
    this.outputTokens += out;
    if (
      this.maxTokens !== undefined &&
      this.inputTokens + this.outputTokens > this.maxTokens
    ) {
      this.trip("max_tokens");
    }
  }

  private countIteration(runId: string): void {
    if (this.tripped) return;
    // Newer LangChain versions may emit both handleLLMStart and
    // handleChatModelStart with the same runId — dedupe defensively.
    if (this.countedRuns.has(runId)) return;
    this.countedRuns.add(runId);
    this.iterations += 1;
    if (this.maxIterations !== undefined && this.iterations > this.maxIterations) {
      this.trip("max_iterations");
    }
  }

  private trip(reason: TripReason): never {
    this.tripped = true;
    const context = this.buildContext(reason);
    if (!this.silent) this.logger(context.message, context);
    throw new CircuitBreakerError(context);
  }

  private buildContext(reason: TripReason): TripContext {
    const metrics = this.metrics;
    const limits = {
      maxIterations: this.maxIterations,
      maxTokens: this.maxTokens,
    };
    const message =
      reason === "max_iterations"
        ? `Agent stopped: reached iteration limit (${metrics.iterations}/${this.maxIterations} iterations; tokens used: ${metrics.tokens.total}).`
        : `Agent stopped: reached token limit (${metrics.tokens.total}/${this.maxTokens} total tokens; in=${metrics.tokens.input}, out=${metrics.tokens.output}; iterations: ${metrics.iterations}${this.maxIterations !== undefined ? `/${this.maxIterations}` : ""}).`;
    return { reason, metrics, limits, message };
  }
}
