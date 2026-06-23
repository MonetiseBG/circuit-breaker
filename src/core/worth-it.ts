import { CircuitBreakerError } from "./errors.js";
import { defaultLogger } from "./logger.js";
import type {
  CircuitBreakerEvent,
  EventListener,
  Logger,
  Metrics,
  ModelPricing,
  OnWorthItStep,
  ResolvedLimits,
  StepUsage,
  TripContext,
  WorthItConfig,
  WorthItControls,
  WorthItMetrics,
  WorthItStepState,
  WorthItWrapperConfig,
} from "./types.js";

const DEFAULT_ALPHA = 0.3;
const DEFAULT_WARN_RATIO = 0.7;
const DEFAULT_OPTIMIZE_RATIO = 0.85;
const DEFAULT_TRIP_RATIO = 0.95;
const DEFAULT_CURRENCY = "USD";
/** Pricing is quoted per this many tokens (the unit providers publish). */
const TOKENS_PER_MILLION = 1_000_000;

/**
 * Tracks developer-defined milestones for Worth-it mode. Progress is delegated
 * entirely to the application layer — the engine never asks the LLM to estimate
 * its own remaining work. `R_s = N_total − N_completed`.
 */
export class ProgressTracker {
  readonly total: number;
  private completed = 0;

  constructor(milestones: readonly string[] | number) {
    const total =
      typeof milestones === "number" ? milestones : milestones.length;
    if (!Number.isInteger(total) || total < 1) {
      throw new TypeError(
        `milestones must be a non-empty array or a positive integer (received ${describe(milestones)})`,
      );
    }
    this.total = total;
  }

  get completedCount(): number {
    return this.completed;
  }

  /** `R_s` — remaining steps. */
  get remaining(): number {
    return this.total - this.completed;
  }

  /** `Progress = N_completed / N_total` ∈ [0, 1]. */
  get progress(): number {
    return this.completed / this.total;
  }

  /** Mark `n` further milestones complete (clamped to `[0, total]`). */
  complete(n = 1): void {
    assertNonNegativeInteger(n, "milestone count");
    this.completed = Math.min(this.total, this.completed + n);
  }

  /** Set the absolute number of completed milestones (clamped to `[0, total]`). */
  set(n: number): void {
    assertNonNegativeInteger(n, "completed milestones");
    this.completed = Math.min(this.total, n);
  }

  reset(): void {
    this.completed = 0;
  }
}

/**
 * Worth-it mode: a real-time, progress-aware cost-monitoring engine that
 * predicts the total cost of an agent run and gates it against a budget
 * ceiling using three graduated thresholds (warn / optimize / checkpoint).
 *
 * Unlike the token-counting {@link CircuitBreaker}, this engine works in
 * currency: each step's cost is `C_s = (I_s·P_in + O_s·P_out) / 1e6` — prices
 * are quoted per million tokens in the currency's smallest unit (e.g. cents) —
 * smoothed into an EMA and projected forward across the milestones still to come.
 *
 * Trip semantics are **checkpoint & pause**, not a permanent kill: a trip
 * throws a {@link CircuitBreakerError}, but the engine stays usable — once the
 * application compacts context or advances milestones, the next
 * {@link recordStep} re-evaluates the projection and can clear the critical
 * state.
 */
export class WorthItEngine {
  readonly mode = "worth-it" as const;

  private readonly budgetLimit: number;
  private readonly alpha: number;
  private readonly warnRatio: number;
  private readonly optimizeRatio: number;
  private readonly tripRatio: number;
  private readonly pricing: Record<string, ModelPricing>;
  private readonly defaultPricing?: ModelPricing;
  private readonly currency: string;

  private readonly progressTracker: ProgressTracker;

  private readonly silent: boolean;
  private readonly logger: Logger;
  private readonly onEvent?: EventListener;

  private step = 0;
  private cumulativeCost = 0;
  private ema = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private last?: WorthItStepState;

  private warned = false;
  private optimized = false;

  constructor(opts: WorthItConfig) {
    assertPositiveFinite(opts.budgetLimit, "budgetLimit");
    this.budgetLimit = opts.budgetLimit;

    this.alpha = opts.alpha ?? DEFAULT_ALPHA;
    if (!(this.alpha > 0 && this.alpha <= 1)) {
      throw new TypeError(
        `alpha must be in the range (0, 1] (received ${describe(opts.alpha)})`,
      );
    }

    this.warnRatio = resolveRatio(opts.warnRatio, DEFAULT_WARN_RATIO, "warnRatio");
    this.optimizeRatio = resolveRatio(
      opts.optimizeRatio,
      DEFAULT_OPTIMIZE_RATIO,
      "optimizeRatio",
    );
    this.tripRatio = resolveRatio(opts.tripRatio, DEFAULT_TRIP_RATIO, "tripRatio");

    this.pricing = opts.pricing ?? {};
    this.defaultPricing = opts.defaultPricing;
    this.currency = opts.currency ?? DEFAULT_CURRENCY;

    this.progressTracker = new ProgressTracker(opts.milestones);

    this.silent = opts.silent ?? false;
    this.logger = opts.logger ?? defaultLogger;
    this.onEvent = opts.onEvent;
  }

  /** Read-only view of the milestone tracker. */
  get progress(): ProgressTracker {
    return this.progressTracker;
  }

  /** Aggregate metrics mirrored from the most recently recorded step. */
  get metrics(): WorthItMetrics {
    const state = this.last ?? this.snapshot(0, 0);
    return {
      ...state,
      steps: this.step,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }

  /** Mark `n` further milestones complete. Affects the next projection. */
  completeMilestone(n = 1): void {
    this.progressTracker.complete(n);
  }

  /** Set the absolute number of completed milestones. */
  setCompletedMilestones(n: number): void {
    this.progressTracker.set(n);
  }

  /**
   * Record one completed step's token telemetry. Computes `C_s`, updates the
   * EMA, projects the run's total cost, and evaluates the graduated thresholds.
   *
   * Emits `predictive_warning` / `optimize_context` as the projection crosses
   * the warn / optimize thresholds (each fires once). When the projection
   * crosses the trip threshold this emits `tripped` and throws a
   * {@link CircuitBreakerError}; the engine itself is not latched, so a
   * subsequent call with improved progress can recover.
   *
   * @returns the resolved {@link WorthItStepState} for this step.
   */
  recordStep(usage: StepUsage): WorthItStepState {
    const stepCost = this.computeStepCost(usage);

    this.step += 1;
    this.cumulativeCost += stepCost;
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.ema =
      this.step === 1
        ? stepCost
        : this.alpha * stepCost + (1 - this.alpha) * this.ema;

    const state = this.snapshot(this.step, stepCost);
    this.last = state;
    this.evaluateThresholds(state);
    return state;
  }

  /**
   * Cost of one step in the currency's smallest unit:
   * `C_s = (I_s·P_in + O_s·P_out + …cache) / 1e6`. Prices are per million tokens,
   * so the token-weighted sum is divided by {@link TOKENS_PER_MILLION}.
   */
  computeStepCost(usage: StepUsage): number {
    assertNonNegativeFinite(usage.input, "usage.input");
    assertNonNegativeFinite(usage.output, "usage.output");
    const price = this.resolvePricing(usage.model);
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    assertNonNegativeFinite(cacheRead, "usage.cacheReadTokens");
    assertNonNegativeFinite(cacheWrite, "usage.cacheWriteTokens");
    return (
      (usage.input * price.inputPerMToken +
        usage.output * price.outputPerMToken +
        cacheRead * (price.cacheReadPerMToken ?? price.inputPerMToken) +
        cacheWrite * (price.cacheWritePerMToken ?? price.inputPerMToken)) /
      TOKENS_PER_MILLION
    );
  }

  reset(): void {
    this.step = 0;
    this.cumulativeCost = 0;
    this.ema = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.last = undefined;
    this.warned = false;
    this.optimized = false;
    this.progressTracker.reset();
  }

  private resolvePricing(model?: string): ModelPricing {
    const price = (model ? this.pricing[model] : undefined) ?? this.defaultPricing;
    if (!price) {
      throw new TypeError(
        model
          ? `No pricing configured for model "${model}" and no defaultPricing set.`
          : "No model specified on the step and no defaultPricing set.",
      );
    }
    return price;
  }

  private snapshot(step: number, stepCost: number): WorthItStepState {
    const remainingSteps = this.progressTracker.remaining;
    const estimatedRemainingCost = this.ema * remainingSteps;
    const projectedCost = this.cumulativeCost + estimatedRemainingCost;
    const progress = this.progressTracker.progress;
    // BBR_s = (C_cum / B_limit) / Progress; 0 when progress is 0 (no NaN).
    const burnRate =
      progress > 0 ? this.cumulativeCost / this.budgetLimit / progress : 0;
    return {
      step,
      stepCost,
      ema: this.ema,
      estimatedRemainingCost,
      cumulativeCost: this.cumulativeCost,
      projectedCost,
      budgetLimit: this.budgetLimit,
      currency: this.currency,
      remainingSteps,
      totalMilestones: this.progressTracker.total,
      completedMilestones: this.progressTracker.completedCount,
      progress,
      burnRate,
    };
  }

  private evaluateThresholds(state: WorthItStepState): void {
    const { projectedCost } = state;
    if (!this.warned && projectedCost > this.warnRatio * this.budgetLimit) {
      this.warned = true;
      this.emit({ type: "predictive_warning", state });
    }
    if (!this.optimized && projectedCost > this.optimizeRatio * this.budgetLimit) {
      this.optimized = true;
      this.emit({ type: "optimize_context", state });
    }
    if (projectedCost > this.tripRatio * this.budgetLimit) {
      this.trip(state);
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

  private trip(state: WorthItStepState): never {
    const context = this.buildContext(state);
    if (!this.silent) this.logger(context.message, context);
    this.emit({ type: "tripped", reason: "budget_projection", state });
    throw new CircuitBreakerError(context);
  }

  private buildContext(state: WorthItStepState): TripContext {
    const metrics: Metrics = {
      iterations: state.step,
      retries: 0,
      tokens: {
        input: this.inputTokens,
        output: this.outputTokens,
        total: this.inputTokens + this.outputTokens,
      },
    };
    const limits: ResolvedLimits = { mode: this.mode };
    const message =
      `Agent stopped: projected cost ${fmt(state.projectedCost, this.currency)} would exceed ` +
      `${Math.round(this.tripRatio * 100)}% of the ${fmt(this.budgetLimit, this.currency)} budget ` +
      `(cumulative ${fmt(state.cumulativeCost, this.currency)}, ERC ${fmt(state.estimatedRemainingCost, this.currency)}; ` +
      `step ${state.step}, ${state.completedMilestones}/${state.totalMilestones} milestones).`;
    return {
      reason: "budget_projection",
      mode: this.mode,
      metrics,
      limits,
      saved: this.budgetLimit - state.projectedCost,
      message,
      worthIt: state,
    };
  }
}

/**
 * Narrows an adapter's option union to its `worth-it` arm, preserving the
 * adapter-specific extras (`onTrip`, `onWorthItStep`) on the narrowed type.
 */
export function isWorthItConfig<T extends { mode?: unknown }>(
  opts: T,
): opts is T & { mode: "worth-it" } {
  return opts.mode === "worth-it";
}

/**
 * Adapter-facing driver that bundles a {@link WorthItEngine} with the developer
 * {@link WorthItControls} and a single per-step entry point. Adapters extract
 * `{ input, output, model }` from each finished step and call {@link recordStep};
 * the developer advances milestones via the `onWorthItStep` hook, which runs
 * just before the step is costed.
 */
export interface WorthItRunner<TStep = unknown> {
  readonly engine: WorthItEngine;
  readonly controls: WorthItControls;
  /**
   * Run the progress hook for `step`, then cost it. Throws
   * {@link CircuitBreakerError} if the projection trips the breaker.
   */
  recordStep(usage: StepUsage, step: TStep): void;
}

export function createWorthItRunner<TStep = unknown>(
  opts: WorthItConfig,
  onWorthItStep?: OnWorthItStep<TStep>,
): WorthItRunner<TStep> {
  const engine = new WorthItEngine(opts);
  const controls: WorthItControls = {
    completeMilestone: (n) => engine.completeMilestone(n),
    setCompletedMilestones: (n) => engine.setCompletedMilestones(n),
    get metrics() {
      return engine.metrics;
    },
  };
  return {
    engine,
    controls,
    recordStep(usage, step) {
      if (onWorthItStep) onWorthItStep(controls, step);
      engine.recordStep(usage);
    },
  };
}

function resolveRatio(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const ratio = value ?? fallback;
  if (!(typeof ratio === "number" && ratio > 0 && ratio <= 1)) {
    throw new TypeError(
      `${name} must be in the range (0, 1] (received ${describe(value)})`,
    );
  }
  return ratio;
}

function assertPositiveFinite(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `${name} must be a positive finite number (received ${describe(value)})`,
    );
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `${name} must be a non-negative finite number (received ${describe(value)})`,
    );
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `${name} must be a non-negative integer (received ${describe(value)})`,
    );
  }
}

/**
 * Format a smallest-unit amount (e.g. cents) for human-readable log messages:
 * converts to the currency's major unit using the ISO minor-unit exponent and
 * appends the currency code — e.g. `fmt(150, "USD")` → `"1.50 USD"`.
 */
function fmt(minor: number, currency: string): string {
  const exp = minorUnitExponent(currency);
  return `${(minor / 10 ** exp).toFixed(exp)} ${currency}`;
}

/** ISO minor-unit digits for `currency` (2 for USD, 0 for JPY); 2 on failure. */
function minorUnitExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency })
        .resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function describe(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return String(value);
  }
  if (typeof value === "string") return `string: "${value}"`;
  if (Array.isArray(value)) return `array(length ${value.length})`;
  return `${typeof value}: ${String(value)}`;
}
