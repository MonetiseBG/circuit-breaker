import { createHash } from "node:crypto";

import { CircuitBreakerError } from "./errors.js";
import { defaultLogger } from "./logger.js";
import { WorthItEngine } from "./worth-it.js";
import type {
  CircuitBreakerEvent,
  EventListener,
  Logger,
  LoopKillerConfig,
  Metrics,
  Mode,
  ResolvedLimits,
  StepUsage,
  StopReason,
  TripContext,
  WorthItMetrics,
  WorthItStepState,
  WrapperModeConfig,
} from "./types.js";

const DEFAULT_MAX_INPUT_TOKEN = 10_000;
const DEFAULT_MAX_OUTPUT_TOKEN = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DETECT_REPEATED_STATE = true;

/**
 * Framework-agnostic circuit breaker — the single entry point for all three
 * modes:
 *
 * - `budget-guard` (default) — caps input and output tokens independently and
 *   trips the run as soon as either bucket is exceeded. Drive it with
 *   {@link recordIteration} + {@link addTokens} / {@link setTokenSnapshot}.
 * - `loop-killer` — caps repeated states. With `detectRepeatedState` (default)
 *   the breaker hashes each step's state key and trips when any single state
 *   recurs more than `maxRetries` times; with detection disabled it falls back
 *   to a plain iteration cap. Drive it with {@link recordIteration}.
 * - `worth-it` — predictive, cost-based budgeting. Delegates to an internal
 *   {@link WorthItEngine}: drive it with {@link recordStep} and advance progress
 *   with {@link completeMilestone} / {@link setCompletedMilestones}.
 *
 * The token/loop methods and the worth-it methods are mutually exclusive —
 * calling one that doesn't match the active mode throws a `TypeError`.
 *
 * One instance corresponds to one logical invocation. Adapters create a fresh
 * breaker per call; {@link reset} clears state if you need to reuse one.
 */
export class CircuitBreaker {
  readonly mode: Mode;

  /** Present only in `worth-it` mode. */
  private readonly worthItEngine?: WorthItEngine;

  private readonly maxInputToken?: number;
  private readonly maxOutputToken?: number;
  private readonly maxRetries?: number;
  private readonly detectRepeatedState?: boolean;

  private readonly silent: boolean;
  private readonly logger: Logger;
  private readonly onEvent?: EventListener;

  private iterations = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private peakRetryDepth = 0;
  private tripped = false;
  private readonly stateCounts = new Map<string, number>();

  constructor(opts: WrapperModeConfig = {}) {
    assertValidMode(opts);
    this.mode = opts.mode ?? "budget-guard";

    this.silent = opts.silent ?? false;
    this.logger = opts.logger ?? defaultLogger;
    this.onEvent = opts.onEvent;

    if (opts.mode === "worth-it") {
      this.worthItEngine = new WorthItEngine(opts);
      return;
    }

    if (isLoopKillerOptions(opts)) {
      const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
      assertPositiveInteger(maxRetries, "maxRetries");
      this.maxRetries = maxRetries;
      this.detectRepeatedState =
        opts.detectRepeatedState ?? DEFAULT_DETECT_REPEATED_STATE;
    } else {
      const maxIn = opts.maxInputToken ?? DEFAULT_MAX_INPUT_TOKEN;
      const maxOut = opts.maxOutputToken ?? DEFAULT_MAX_OUTPUT_TOKEN;
      assertPositiveInteger(maxIn, "maxInputToken");
      assertPositiveInteger(maxOut, "maxOutputToken");
      this.maxInputToken = maxIn;
      this.maxOutputToken = maxOut;
    }
  }

  get metrics(): Metrics {
    if (this.worthItEngine) {
      const m = this.worthItEngine.metrics;
      return {
        iterations: m.steps,
        retries: 0,
        tokens: {
          input: m.inputTokens,
          output: m.outputTokens,
          total: m.inputTokens + m.outputTokens,
        },
      };
    }
    return {
      iterations: this.iterations,
      retries: this.currentRetries(),
      tokens: {
        input: this.inputTokens,
        output: this.outputTokens,
        total: this.inputTokens + this.outputTokens,
      },
    };
  }

  /**
   * Rich cost/progress metrics for `worth-it` mode. `undefined` in the
   * token/loop modes (use {@link metrics} there).
   */
  get worthItMetrics(): WorthItMetrics | undefined {
    return this.worthItEngine?.metrics;
  }

  get isTripped(): boolean {
    // `worth-it` is checkpoint & pause, not a latched trip — it re-evaluates
    // each step, so there is no persistent tripped state to report.
    return this.tripped;
  }

  reset(): void {
    if (this.worthItEngine) {
      this.worthItEngine.reset();
      return;
    }
    this.iterations = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.peakRetryDepth = 0;
    this.tripped = false;
    this.stateCounts.clear();
  }

  /**
   * `worth-it` mode: record one completed step's token telemetry (cost). Throws
   * a `CircuitBreakerError` when the projected total trips the budget. Throws a
   * `TypeError` in the token/loop modes — use {@link addTokens} there.
   */
  recordStep(usage: StepUsage): WorthItStepState {
    return this.requireWorthIt("recordStep").recordStep(usage);
  }

  /** `worth-it` mode: mark `n` further milestones complete (default 1). */
  completeMilestone(n = 1): void {
    this.requireWorthIt("completeMilestone").completeMilestone(n);
  }

  /** `worth-it` mode: set the absolute number of completed milestones. */
  setCompletedMilestones(n: number): void {
    this.requireWorthIt("setCompletedMilestones").setCompletedMilestones(n);
  }

  private requireWorthIt(method: string): WorthItEngine {
    if (!this.worthItEngine) {
      throw new TypeError(
        `${method}() is only available in "worth-it" mode (current mode: "${this.mode}").`,
      );
    }
    return this.worthItEngine;
  }

  private assertNotWorthIt(method: string): void {
    if (this.worthItEngine) {
      throw new TypeError(
        `${method}() is not available in "worth-it" mode; use recordStep() instead.`,
      );
    }
  }

  /**
   * Record one logical iteration (LLM call / agent turn). For `loop-killer`
   * mode with `detectRepeatedState`, pass a `stateKey` summarising the step
   * (e.g. the chat prompt or turn input) — the breaker hashes it to detect
   * loops. Ignored in `budget-guard` mode.
   */
  recordIteration(stateKey?: string): void {
    this.assertNotWorthIt("recordIteration");
    if (this.tripped) return;
    this.iterations += 1;
    if (this.mode !== "loop-killer") return;

    if (this.detectRepeatedState) {
      if (stateKey === undefined) return;
      const hash = hashState(stateKey);
      const count = (this.stateCounts.get(hash) ?? 0) + 1;
      this.stateCounts.set(hash, count);
      const depth = count - 1;
      if (depth > this.peakRetryDepth) this.peakRetryDepth = depth;
      if (depth >= 1) this.emit({ type: "retry", retries: depth });
      if (this.maxRetries !== undefined && depth > this.maxRetries) {
        this.trip("repeated_state");
      }
      return;
    }

    const retries = this.iterations - 1;
    if (retries >= 1) this.emit({ type: "retry", retries });
    if (this.maxRetries !== undefined && retries > this.maxRetries) {
      this.trip("max_retries");
    }
  }

  /** Add per-call delta token counts. */
  addTokens(input: number, output: number): void {
    this.assertNotWorthIt("addTokens");
    if (this.tripped) return;
    this.inputTokens += input;
    this.outputTokens += output;
    this.checkTokenLimit();
  }

  /** Set absolute aggregate token counts (for frameworks that expose totals). */
  setTokenSnapshot(input: number, output: number): void {
    this.assertNotWorthIt("setTokenSnapshot");
    if (this.tripped) return;
    this.inputTokens = input;
    this.outputTokens = output;
    this.checkTokenLimit();
  }

  /**
   * Trip *before* a provider call when the estimated input token count would
   * overshoot `maxInputToken`. Use from adapters as a preflight check so an
   * oversized initial prompt never reaches the provider. Pass a non-negative
   * integer; this does not mutate `inputTokens` — provider-reported usage
   * still accumulates afterwards via {@link addTokens} / {@link setTokenSnapshot}.
   * No-op outside `budget-guard` mode or when the breaker has already tripped.
   */
  checkInputEstimate(estimatedInputTokens: number): void {
    if (this.tripped) return;
    if (this.mode !== "budget-guard") return;
    if (this.maxInputToken === undefined) return;
    if (
      typeof estimatedInputTokens !== "number" ||
      !Number.isFinite(estimatedInputTokens) ||
      estimatedInputTokens < 0
    ) {
      throw new TypeError(
        `estimatedInputTokens must be a non-negative finite number (received ${describe(estimatedInputTokens)})`,
      );
    }
    if (estimatedInputTokens > this.maxInputToken) {
      this.inputTokens = estimatedInputTokens;
      this.trip("max_input_tokens");
    }
  }

  private currentRetries(): number {
    if (this.mode !== "loop-killer") return 0;
    return this.detectRepeatedState
      ? this.peakRetryDepth
      : Math.max(0, this.iterations - 1);
  }

  private checkTokenLimit(): void {
    if (this.mode !== "budget-guard") return;
    if (this.maxInputToken !== undefined && this.inputTokens > this.maxInputToken) {
      this.trip("max_input_tokens");
      return;
    }
    if (
      this.maxOutputToken !== undefined &&
      this.outputTokens > this.maxOutputToken
    ) {
      this.trip("max_output_tokens");
    }
  }

  private emit(event: CircuitBreakerEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      // Listener errors must never break the agent run.
    }
  }

  private trip(reason: StopReason): never {
    this.tripped = true;
    const context = this.buildContext(reason);
    if (!this.silent) this.logger(context.message, context);
    this.emit({ type: "stop", reason, saved: context.saved });
    throw new CircuitBreakerError(context);
  }

  private buildContext(reason: StopReason): TripContext {
    const metrics = this.metrics;
    const limits: ResolvedLimits = {
      mode: this.mode,
      maxInputToken: this.maxInputToken,
      maxOutputToken: this.maxOutputToken,
      maxRetries: this.maxRetries,
      detectRepeatedState: this.detectRepeatedState,
    };
    const saved = this.computeSaved(metrics);
    const message = this.buildMessage(reason, metrics);
    return { reason, mode: this.mode, metrics, limits, saved, message };
  }

  private computeSaved(metrics: Metrics): number {
    if (this.mode === "budget-guard") {
      const limit = (this.maxInputToken ?? 0) + (this.maxOutputToken ?? 0);
      return limit - metrics.tokens.total;
    }
    return (this.maxRetries ?? 0) - metrics.retries;
  }

  private buildMessage(reason: StopReason, metrics: Metrics): string {
    switch (reason) {
      case "max_input_tokens":
        return `Agent stopped: input token budget exceeded (${metrics.tokens.input}/${this.maxInputToken}; iterations: ${metrics.iterations}).`;
      case "max_output_tokens":
        return `Agent stopped: output token budget exceeded (${metrics.tokens.output}/${this.maxOutputToken}; iterations: ${metrics.iterations}).`;
      case "max_retries":
        return `Agent stopped: retry limit reached (${metrics.retries}/${this.maxRetries} retries; iterations: ${metrics.iterations}).`;
      case "repeated_state":
        return `Agent stopped: repeated state detected (${metrics.retries}/${this.maxRetries} retries; iterations: ${metrics.iterations}).`;
      case "budget_projection":
        // Worth-it mode trips are produced by WorthItEngine, never here.
        return `Agent stopped: projected budget exceeded (iterations: ${metrics.iterations}).`;
    }
  }
}

function hashState(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function isValidMode(value: unknown): value is Mode {
  return (
    value === "budget-guard" || value === "loop-killer" || value === "worth-it"
  );
}

function assertValidMode(opts: WrapperModeConfig): void {
  const mode = (opts as { mode?: unknown }).mode;
  if (mode === undefined || isValidMode(mode)) return;
  throw new TypeError(
    `mode must be "budget-guard", "loop-killer" or "worth-it" (received ${describe(mode)})`,
  );
}

function isLoopKillerOptions(opts: WrapperModeConfig): opts is LoopKillerConfig {
  return opts.mode === "loop-killer";
}

function assertPositiveInteger(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `${name} must be a positive integer (received ${describe(value)})`,
    );
  }
}

function describe(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return String(value);
  }
  if (typeof value === "string") return `string: "${value}"`;
  return `${typeof value}: ${String(value)}`;
}
