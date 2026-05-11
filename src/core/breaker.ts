import { CircuitBreakerError } from "./errors.js";
import { defaultLogger } from "./logger.js";
import type {
  CircuitBreakerOptions,
  Logger,
  Metrics,
  TripContext,
  TripReason,
} from "./types.js";

/**
 * Framework-agnostic circuit breaker.
 *
 * Holds the shared decision logic (iteration counter, token accumulator,
 * limit checks, log + throw on trip). Provider adapters (LangChain callback,
 * OpenAI Agents hook, …) translate their respective lifecycle events into
 * calls on this class.
 *
 * One instance corresponds to one logical invocation. Adapters create a fresh
 * breaker per call; call {@link reset} if you need to reuse one.
 */
export class CircuitBreaker {
  private readonly maxIterations?: number;
  private readonly maxTokens?: number;
  private readonly silent: boolean;
  private readonly logger: Logger;

  private iterations = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private tripped = false;

  constructor(opts: CircuitBreakerOptions = {}) {
    if (
      opts.maxIterations !== undefined &&
      (!Number.isFinite(opts.maxIterations) || opts.maxIterations < 1)
    ) {
      throw new TypeError("maxIterations must be a finite number >= 1");
    }
    if (
      opts.maxTokens !== undefined &&
      (!Number.isFinite(opts.maxTokens) || opts.maxTokens < 1)
    ) {
      throw new TypeError("maxTokens must be a finite number >= 1");
    }
    if (opts.maxIterations === undefined && opts.maxTokens === undefined) {
      throw new TypeError(
        "CircuitBreaker requires at least one of maxIterations or maxTokens",
      );
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

  get isTripped(): boolean {
    return this.tripped;
  }

  reset(): void {
    this.iterations = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.tripped = false;
  }

  /**
   * Record one logical iteration (one LLM call or one agent turn, depending
   * on what the adapter chooses to count). Throws if this push goes over the
   * iteration limit.
   */
  recordIteration(): void {
    if (this.tripped) return;
    this.iterations += 1;
    if (this.maxIterations !== undefined && this.iterations > this.maxIterations) {
      this.trip("max_iterations");
    }
  }

  /**
   * Add delta token counts from a single LLM call. Use when the adapter
   * observes per-call usage (e.g. LangChain's handleLLMEnd).
   */
  addTokens(input: number, output: number): void {
    if (this.tripped) return;
    this.inputTokens += input;
    this.outputTokens += output;
    this.checkTokenLimit();
  }

  /**
   * Set absolute aggregate token counts. Use when the adapter sees a running
   * total maintained by the agent framework (e.g. `RunContext.usage` in
   * @openai/agents) instead of per-call deltas.
   */
  setTokenSnapshot(input: number, output: number): void {
    if (this.tripped) return;
    this.inputTokens = input;
    this.outputTokens = output;
    this.checkTokenLimit();
  }

  private checkTokenLimit(): void {
    if (
      this.maxTokens !== undefined &&
      this.inputTokens + this.outputTokens > this.maxTokens
    ) {
      this.trip("max_tokens");
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
