import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CircuitBreaker,
  CircuitBreakerError,
  ProgressTracker,
  WorthItEngine,
  createWorthItRunner,
  isWorthItConfig,
  type CircuitBreakerEvent,
  type StepUsage,
  type TripContext,
  type WorthItConfig,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
//
// Pricing is quoted PER MILLION TOKENS, in the currency's smallest unit (e.g.
// cents). FLAT prices both legs at 10_000 per 1M tokens → 0.01 per token, so a
// step costs `(input + output) · 0.01`. Every engine step below feeds a
// NON-ZERO input (we never drive cost with output alone).
// ---------------------------------------------------------------------------
const FLAT = { inputPerMToken: 10_000, outputPerMToken: 10_000 };

/** A usage whose cost is exactly `minor` units under FLAT, with `input > 0`. */
function spend(minor: number): StepUsage {
  const tokens = Math.round(minor / 0.01);
  const input = Math.max(1, Math.floor(tokens / 3));
  return { input, output: tokens - input };
}

function makeEngine(opts: Partial<WorthItConfig> = {}): WorthItEngine {
  return new WorthItEngine({
    budgetLimit: 1.0,
    milestones: 1,
    defaultPricing: FLAT,
    silent: true,
    ...opts,
  });
}

function collect(): {
  events: CircuitBreakerEvent[];
  onEvent: (e: CircuitBreakerEvent) => void;
} {
  const events: CircuitBreakerEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

/** Record a step, swallowing the trip throw and returning the serialized state. */
function tripState(engine: WorthItEngine, usage: StepUsage): CircuitBreakerError {
  try {
    engine.recordStep(usage);
  } catch (err) {
    return err as CircuitBreakerError;
  }
  throw new Error("expected recordStep to trip");
}

// ===========================================================================
// 1. ProgressTracker
// ===========================================================================
describe("ProgressTracker", () => {
  it("PT-C1/C3 constructs from a positive integer", () => {
    const pt = new ProgressTracker(5);
    expect(pt.total).toBe(5);
    expect(pt.completedCount).toBe(0);
    expect(pt.remaining).toBe(5);
    expect(pt.progress).toBe(0);
    expect(new ProgressTracker(1).total).toBe(1);
  });

  it("PT-C2/C4 constructs from an array (incl. frozen)", () => {
    expect(new ProgressTracker(["plan", "fetch", "write"]).total).toBe(3);
    expect(new ProgressTracker(Object.freeze(["a", "b"])).total).toBe(2);
  });

  it("PT-C5..C10 rejects invalid totals", () => {
    expect(() => new ProgressTracker(0)).toThrow(TypeError);
    expect(() => new ProgressTracker([])).toThrow(TypeError);
    expect(() => new ProgressTracker(-1)).toThrow(TypeError);
    expect(() => new ProgressTracker(2.5)).toThrow(TypeError);
    expect(() => new ProgressTracker(NaN)).toThrow(TypeError);
    expect(() => new ProgressTracker(Infinity)).toThrow(TypeError);
    expect(() => new ProgressTracker(-Infinity)).toThrow(TypeError);
  });

  it("PT-C11 error message includes the describe()-formatted value", () => {
    expect(() => new ProgressTracker(2.5)).toThrow(/2\.5/);
    expect(() => new ProgressTracker(NaN)).toThrow(/NaN/);
    expect(() => new ProgressTracker(Infinity)).toThrow(/Infinity/);
    expect(() => new ProgressTracker(-Infinity)).toThrow(/-Infinity/);
    expect(() => new ProgressTracker([])).toThrow(/array\(length 0\)/);
  });

  it("PT-A1..A3 accessors reflect completion", () => {
    const pt = new ProgressTracker(3);
    pt.complete();
    expect(pt.completedCount).toBe(1);
    expect(pt.remaining).toBe(2);
    expect(pt.progress).toBeCloseTo(1 / 3, 10);
  });

  it("PT-M1..M8 mutators advance, clamp and reset", () => {
    const pt = new ProgressTracker(2);
    pt.complete();
    expect(pt.completedCount).toBe(1); // default arg
    pt.complete(99);
    expect(pt.completedCount).toBe(2); // clamps at total
    pt.set(0);
    expect(pt.completedCount).toBe(0);
    pt.set(5);
    expect(pt.completedCount).toBe(2); // set clamps too
    pt.reset();
    expect(pt.completedCount).toBe(0);
    expect(pt.remaining).toBe(2);
    expect(pt.progress).toBe(0);
  });

  it("PT-V1..V5 rejects invalid mutator args with named messages", () => {
    const pt = new ProgressTracker(3);
    expect(() => pt.complete(-1)).toThrow(/milestone count/);
    expect(() => pt.complete(1.5)).toThrow(TypeError);
    expect(() => pt.complete(NaN)).toThrow(TypeError);
    expect(() => pt.set(-1)).toThrow(/completed milestones/);
    expect(() => pt.set(2.3)).toThrow(TypeError);
    expect(() => pt.set(NaN)).toThrow(TypeError);
  });
});

// ===========================================================================
// 2. WorthItEngine — construction & validation
// ===========================================================================
describe("WorthItEngine — construction & validation", () => {
  it("EC-B1..B7 validates budgetLimit", () => {
    expect(() => makeEngine({ budgetLimit: 1.0 })).not.toThrow();
    expect(() => makeEngine({ budgetLimit: 0 })).toThrow(/budgetLimit/);
    expect(() => makeEngine({ budgetLimit: -1 })).toThrow(TypeError);
    expect(() => makeEngine({ budgetLimit: NaN })).toThrow(TypeError);
    expect(() => makeEngine({ budgetLimit: Infinity })).toThrow(TypeError);
    expect(() => makeEngine({ budgetLimit: "5" as never })).toThrow(/string: "5"/);
    // describe()'s fallback arm formats non-number/string/array values
    expect(() => makeEngine({ budgetLimit: {} as never })).toThrow(/object:/);
  });

  it("EC-A2..A8 validates alpha and accepts the (0,1] boundary", () => {
    expect(() => makeEngine({ alpha: 1 })).not.toThrow();
    expect(() => makeEngine({ alpha: 0.01 })).not.toThrow();
    expect(() => makeEngine({ alpha: 0 })).toThrow(/alpha/);
    expect(() => makeEngine({ alpha: 1.5 })).toThrow(/alpha/);
    expect(() => makeEngine({ alpha: -0.5 })).toThrow(TypeError);
    expect(() => makeEngine({ alpha: NaN })).toThrow(/alpha/);
  });

  it("EC-R1..R9 validates ratios independently (no ordering invariant)", () => {
    expect(() => makeEngine({ warnRatio: 0.5, optimizeRatio: 0.6, tripRatio: 0.8 })).not.toThrow();
    expect(() => makeEngine({ tripRatio: 1 })).not.toThrow(); // inclusive upper bound
    expect(() => makeEngine({ warnRatio: 0 })).toThrow(/warnRatio/);
    expect(() => makeEngine({ optimizeRatio: 1.2 })).toThrow(/optimizeRatio/);
    expect(() => makeEngine({ tripRatio: -0.1 })).toThrow(/tripRatio/);
    expect(() => makeEngine({ warnRatio: NaN })).toThrow(/warnRatio/);
    // "inverted" ratios (trip < warn) are individually valid — not cross-checked.
    expect(() => makeEngine({ warnRatio: 0.9, tripRatio: 0.5 })).not.toThrow();
  });

  it("EC-O4 exposes the literal mode discriminant", () => {
    expect(makeEngine().mode).toBe("worth-it");
  });

  it("currency defaults to USD and is carried on emitted state", () => {
    expect(makeEngine().metrics.currency).toBe("USD");
    const custom = makeEngine({ currency: "EUR" });
    custom.completeMilestone();
    expect(custom.recordStep(spend(0.01)).currency).toBe("EUR");
  });

  it("an invalid currency code never crashes a trip (falls back gracefully)", () => {
    // A bad ISO code must not throw a RangeError mid-run when formatting the
    // trip message — the breaker error is what callers depend on.
    const engine = makeEngine({ currency: "NOPE", budgetLimit: 500, milestones: 1 });
    engine.completeMilestone();
    const err = tripState(engine, { input: 20000, output: 40000 }); // cost 600
    expect(err).toBeInstanceOf(CircuitBreakerError);
    expect(err.message).toContain("NOPE"); // fmt fell back to 2-dp formatting
  });
});

// ===========================================================================
// 3. Getters
// ===========================================================================
describe("WorthItEngine — getters", () => {
  it("GET-1 exposes the live ProgressTracker", () => {
    const engine = makeEngine({ milestones: 4 });
    engine.progress.complete(2);
    expect(engine.progress.completedCount).toBe(2);
    expect(engine.progress.remaining).toBe(2);
  });

  it("GET-2 metrics before any step use the snapshot(0,0) branch", () => {
    const engine = makeEngine({ milestones: 3 });
    const m = engine.metrics;
    expect(m.steps).toBe(0);
    expect(m.step).toBe(0);
    expect(m.stepCost).toBe(0);
    expect(m.ema).toBe(0);
    expect(m.cumulativeCost).toBe(0);
    expect(m.projectedCost).toBe(0);
    expect(m.burnRate).toBe(0);
    expect(m.progress).toBe(0);
    expect(m.remainingSteps).toBe(3);
    expect(m.totalMilestones).toBe(3);
    expect(m.inputTokens).toBe(0);
    expect(m.outputTokens).toBe(0);
  });

  it("GET-3/GET-4 metrics after steps mirror the last state + step count", () => {
    const engine = makeEngine({ budgetLimit: 1000, milestones: 3 });
    engine.recordStep(spend(0.1));
    const s2 = engine.recordStep(spend(0.2));
    const m = engine.metrics;
    expect(m.steps).toBe(2);
    expect(m.step).toBe(2);
    expect(m.cumulativeCost).toBeCloseTo(s2.cumulativeCost, 10);
    expect(m.ema).toBeCloseTo(s2.ema, 10);
  });
});

// ===========================================================================
// 4. recordStep — EMA, accumulation, projection
// ===========================================================================
describe("WorthItEngine.recordStep — EMA compounding", () => {
  it("RS-E1 matches the EMA/ERC recursion exactly for α=0.5, R_s=2", () => {
    const engine = makeEngine({ budgetLimit: 1000, alpha: 0.5, milestones: 2 });

    const s1 = engine.recordStep(spend(0.1)); // C_1 = 0.10
    expect(s1.stepCost).toBeCloseTo(0.1, 10);
    expect(s1.ema).toBeCloseTo(0.1, 10); // EMA_1 = C_1
    expect(s1.estimatedRemainingCost).toBeCloseTo(0.2, 10);

    const s2 = engine.recordStep(spend(0.2)); // C_2 = 0.20
    expect(s2.stepCost).toBeCloseTo(0.2, 10);
    expect(s2.ema).toBeCloseTo(0.15, 10); // 0.5·0.20 + 0.5·0.10
    expect(s2.estimatedRemainingCost).toBeCloseTo(0.3, 10);

    const s3 = engine.recordStep(spend(0.4)); // C_3 = 0.40
    expect(s3.stepCost).toBeCloseTo(0.4, 10);
    expect(s3.ema).toBeCloseTo(0.275, 10); // 0.5·0.40 + 0.5·0.15
    expect(s3.estimatedRemainingCost).toBeCloseTo(0.55, 10);
  });

  it("RS-E3 α=1 makes EMA track the latest step cost (no smoothing)", () => {
    const engine = makeEngine({ budgetLimit: 1000, alpha: 1, milestones: 2 });
    expect(engine.recordStep(spend(0.1)).ema).toBeCloseTo(0.1, 10);
    expect(engine.recordStep(spend(0.4)).ema).toBeCloseTo(0.4, 10);
  });

  it("RS-E4 default α=0.3 is wired in (EMA_2 = 0.3·C_2 + 0.7·C_1)", () => {
    const engine = makeEngine({ budgetLimit: 1000, milestones: 2 });
    engine.recordStep(spend(0.1));
    expect(engine.recordStep(spend(0.2)).ema).toBeCloseTo(0.13, 10);
  });

  it("RS-A1..A3 accumulates cost, tokens and a 1-based step index", () => {
    const engine = makeEngine({ budgetLimit: 1000, milestones: 5 });
    const s1 = engine.recordStep({ input: 30, output: 70 }); // cost 1.00
    expect(s1.step).toBe(1);
    const s2 = engine.recordStep({ input: 10, output: 40 }); // cost 0.50
    expect(s2.step).toBe(2);
    expect(s2.cumulativeCost).toBeCloseTo(1.5, 10);
    expect(engine.metrics.inputTokens).toBe(40);
    expect(engine.metrics.outputTokens).toBe(110);
  });
});

describe("WorthItEngine.recordStep — progress projection", () => {
  it("RS-P1 trips at step 1, then clears once milestones advance (non-latching)", () => {
    const engine = makeEngine({ milestones: 4 });

    // Step 1: 0 milestones done, R_s = 4. C_proj = 0.20 + 0.20·4 = 1.00 → trip.
    const err = tripState(engine, spend(0.2));
    expect(err.reason).toBe("budget_projection");
    expect(err.mode).toBe("worth-it");
    expect(err.worthIt?.step).toBe(1);
    expect(err.worthIt?.projectedCost).toBeCloseTo(1.0, 10);

    // Mark 2 milestones complete, record an equal step. C_proj = 0.40 + 0.20·2 = 0.80.
    engine.completeMilestone(2);
    const s2 = engine.recordStep(spend(0.2));
    expect(s2.cumulativeCost).toBeCloseTo(0.4, 10);
    expect(s2.remainingSteps).toBe(2);
    expect(s2.projectedCost).toBeCloseTo(0.8, 10);
  });

  it("RS-P2 with R_s=0 the projection equals cumulative cost", () => {
    const engine = makeEngine({ budgetLimit: 1000, milestones: 1 });
    engine.completeMilestone();
    const s = engine.recordStep(spend(0.5));
    expect(s.remainingSteps).toBe(0);
    expect(s.estimatedRemainingCost).toBe(0);
    expect(s.projectedCost).toBeCloseTo(s.cumulativeCost, 10);
  });

  it("RS-P3/P4 advancing progress lowers the projection; complete == set", () => {
    const a = makeEngine({ budgetLimit: 1000, milestones: 4 });
    const b = makeEngine({ budgetLimit: 1000, milestones: 4 });
    a.completeMilestone(2);
    b.setCompletedMilestones(2);
    const sa = a.recordStep(spend(0.2));
    const sb = b.recordStep(spend(0.2));
    expect(sa.remainingSteps).toBe(2);
    expect(sa.projectedCost).toBeCloseTo(sb.projectedCost, 10);
  });

  it("RS-Z1/Z2 a zero-cost step is well-defined (no NaN, no events)", () => {
    const { events, onEvent } = collect();
    const engine = makeEngine({ budgetLimit: 1000, milestones: 4, onEvent });
    const s = engine.recordStep({ input: 0, output: 0 }); // priced, but 0 tokens
    expect(s.stepCost).toBe(0);
    expect(s.ema).toBe(0);
    expect(s.cumulativeCost).toBe(0);
    expect(s.burnRate).toBe(0);
    expect(Number.isNaN(s.burnRate)).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("RS-Z3 a single huge step trips immediately on step 1", () => {
    const engine = makeEngine({ milestones: 1 });
    engine.completeMilestone();
    const err = tripState(engine, spend(2.0));
    expect(err.worthIt?.step).toBe(1);
  });
});

// ===========================================================================
// 5. computeStepCost & pricing resolution
// ===========================================================================
describe("WorthItEngine.computeStepCost & pricing", () => {
  it("CC-1 prices input + output + cache legs via the active model", () => {
    const engine = makeEngine({
      budgetLimit: 1000,
      pricing: {
        "model-a": {
          inputPerMToken: 1000, // 0.001/token
          outputPerMToken: 2000, // 0.002/token
          cacheReadPerMToken: 100, // 0.0001/token
        },
      },
    });
    const cost = engine.computeStepCost({
      input: 100, // 0.1
      output: 50, // 0.1
      cacheReadTokens: 1000, // 0.1
      cacheWriteTokens: 100, // 0.1 — cacheWrite falls back to inputPerMToken
      model: "model-a",
    });
    expect(cost).toBeCloseTo(0.4, 10);
  });

  it("CC-2/CC-5 folds cache into the input rate; omitted cache tokens cost 0", () => {
    const engine = makeEngine({
      budgetLimit: 1000,
      defaultPricing: { inputPerMToken: 10_000, outputPerMToken: 0 },
    });
    // (10 input + 5 cacheRead + 5 cacheWrite) · 0.01 = 0.20
    expect(
      engine.computeStepCost({ input: 10, output: 0, cacheReadTokens: 5, cacheWriteTokens: 5 }),
    ).toBeCloseTo(0.2, 10);
    // omitted cache tokens default to 0
    expect(engine.computeStepCost({ input: 10, output: 0 })).toBeCloseTo(0.1, 10);
  });

  it("CC-3/CC-4 cache legs priced independently when set", () => {
    const engine = makeEngine({
      budgetLimit: 1000,
      defaultPricing: {
        inputPerMToken: 10_000, // 0.01
        outputPerMToken: 0,
        cacheReadPerMToken: 1000, // 0.001
        cacheWritePerMToken: 100, // 0.0001
      },
    });
    // 1000·0.01 + 1000·0.001 + 1000·0.0001 = 10 + 1 + 0.1 = 11.1
    expect(
      engine.computeStepCost({
        input: 1000,
        output: 0,
        cacheReadTokens: 1000,
        cacheWriteTokens: 1000,
      }),
    ).toBeCloseTo(11.1, 10);
  });

  it("CC-V1..V9 rejects negative / non-finite token counts (input first)", () => {
    const engine = makeEngine({ budgetLimit: 1000 });
    expect(() => engine.computeStepCost({ input: -1, output: 1 })).toThrow(/usage\.input/);
    expect(() => engine.computeStepCost({ input: 1, output: -1 })).toThrow(/usage\.output/);
    expect(() => engine.computeStepCost({ input: NaN, output: 1 })).toThrow(TypeError);
    expect(() => engine.computeStepCost({ input: 1, output: Infinity })).toThrow(TypeError);
    expect(() =>
      engine.computeStepCost({ input: 1, output: 1, cacheReadTokens: -1 }),
    ).toThrow(/usage\.cacheReadTokens/);
    expect(() =>
      engine.computeStepCost({ input: 1, output: 1, cacheWriteTokens: NaN }),
    ).toThrow(/usage\.cacheWriteTokens/);
    // input is validated before output → input error wins
    expect(() => engine.computeStepCost({ input: -1, output: -1 })).toThrow(/usage\.input/);
    // boundary: 0/0 accepted
    expect(engine.computeStepCost({ input: 0, output: 0 })).toBe(0);
  });

  it("PR-1..PR-5 resolves per-model price, default fallback and missing-price errors", () => {
    const engine = makeEngine({
      budgetLimit: 1000,
      pricing: { known: { inputPerMToken: 2000, outputPerMToken: 0 } },
      defaultPricing: { inputPerMToken: 10_000, outputPerMToken: 0 },
    });
    expect(engine.computeStepCost({ input: 1000, output: 0, model: "known" })).toBeCloseTo(2, 10);
    expect(engine.computeStepCost({ input: 1000, output: 0, model: "other" })).toBeCloseTo(10, 10);
    expect(engine.computeStepCost({ input: 1000, output: 0 })).toBeCloseTo(10, 10);

    const noDefault = makeEngine({ budgetLimit: 1000, defaultPricing: undefined });
    expect(() => noDefault.computeStepCost({ input: 1, output: 1 })).toThrow(
      /No model specified/,
    );
    const noDefaultButModel = new WorthItEngine({
      budgetLimit: 1000,
      milestones: 1,
      pricing: {},
      silent: true,
    });
    expect(() =>
      noDefaultButModel.computeStepCost({ input: 1, output: 1, model: "gpt-x" }),
    ).toThrow(/No pricing configured for model "gpt-x"/);
  });

  it("PR-6 input validation runs before pricing resolution", () => {
    const engine = new WorthItEngine({ budgetLimit: 1000, milestones: 1, silent: true });
    // no pricing at all, but a bad input still throws the input error first
    expect(() => engine.computeStepCost({ input: -1, output: 1 })).toThrow(/usage\.input/);
  });
});

// ===========================================================================
// 6. Thresholds & events
// ===========================================================================
describe("WorthItEngine — thresholds & events", () => {
  // R_s=0 so C_proj = C_cum; drive cumulative across the boundaries directly.
  function gated(onEvent: (e: CircuitBreakerEvent) => void): WorthItEngine {
    const engine = makeEngine({ milestones: 1, onEvent });
    engine.completeMilestone();
    return engine;
  }

  it("TH-1 fires each advisory once and trips at 0.95", () => {
    const { events, onEvent } = collect();
    const engine = gated(onEvent);

    engine.recordStep(spend(0.69));
    expect(events).toHaveLength(0);

    engine.recordStep(spend(0.02)); // → 0.71
    expect(events.filter((e) => e.type === "predictive_warning")).toHaveLength(1);

    engine.recordStep(spend(0.13)); // → 0.84, no new event
    expect(events.filter((e) => e.type === "optimize_context")).toHaveLength(0);

    engine.recordStep(spend(0.02)); // → 0.86
    expect(events.filter((e) => e.type === "optimize_context")).toHaveLength(1);

    engine.recordStep(spend(0.08)); // → 0.94, no trip
    expect(events.some((e) => e.type === "tripped")).toBe(false);

    const err = tripState(engine, spend(0.02)); // → 0.96
    expect(err).toBeInstanceOf(CircuitBreakerError);
    const tripped = events.filter((e) => e.type === "tripped");
    expect(tripped).toHaveLength(1);
    expect(tripped[0]?.type === "tripped" && tripped[0].state.step).toBe(6);
    // advisories still fired exactly once across the whole run
    expect(events.filter((e) => e.type === "predictive_warning")).toHaveLength(1);
    expect(events.filter((e) => e.type === "optimize_context")).toHaveLength(1);
  });

  it("TH-2 thresholds are strictly greater-than (no fire at the exact boundary)", () => {
    const { events, onEvent } = collect();
    const engine = gated(onEvent);
    engine.recordStep(spend(0.7)); // C_proj === 0.70 exactly → NO warn
    expect(events).toHaveLength(0);
    engine.recordStep(spend(0.01)); // → 0.71 → warn
    expect(events.filter((e) => e.type === "predictive_warning")).toHaveLength(1);
  });

  it("TH-3 a single big step crosses warn → optimize → trip in order", () => {
    const { events, onEvent } = collect();
    const engine = gated(onEvent);
    const err = tripState(engine, spend(0.96));
    expect(events.map((e) => e.type)).toEqual([
      "predictive_warning",
      "optimize_context",
      "tripped",
    ]);
    expect(err.worthIt?.step).toBe(1);
  });

  it("TH-4 latches persist — a dip below warn does not re-fire on the next rise", () => {
    // R_s = 10 (no milestones complete) so the projection is dominated by EMA·R_s
    // and we can dip below / rise above warn via step cost without tripping.
    const { events, onEvent } = collect();
    const engine = makeEngine({ budgetLimit: 1000, milestones: 10, onEvent });
    engine.recordStep(spend(65)); // C_proj = 65 + 65·10 = 715 → warn
    expect(events.filter((e) => e.type === "predictive_warning")).toHaveLength(1);
    engine.recordStep(spend(1)); // ema 45.8 → C_proj 524, dips below warn
    engine.recordStep(spend(100)); // ema 62.06 → C_proj 786.6, rises above warn again
    expect(events.filter((e) => e.type === "predictive_warning")).toHaveLength(1);
    expect(events.some((e) => e.type === "tripped")).toBe(false);
  });

  it("TH-5 custom ratios move the crossing points earlier", () => {
    const { events, onEvent } = collect();
    const engine = makeEngine({ milestones: 1, warnRatio: 0.5, onEvent });
    engine.completeMilestone();
    engine.recordStep(spend(0.51)); // > 0.50 → warn
    expect(events.filter((e) => e.type === "predictive_warning")).toHaveLength(1);
  });

  it("TH-7 trip is not suppressed — consecutive over-budget steps each throw", () => {
    const engine = makeEngine({ milestones: 1 });
    engine.completeMilestone();
    expect(() => engine.recordStep(spend(0.96))).toThrow(CircuitBreakerError);
    expect(() => engine.recordStep(spend(0.01))).toThrow(CircuitBreakerError);
  });

  it("EV-2 a throwing onEvent listener never surfaces", () => {
    const engine = makeEngine({
      milestones: 1,
      onEvent: () => {
        throw new Error("listener boom");
      },
    });
    engine.completeMilestone();
    expect(() => engine.recordStep(spend(0.71))).not.toThrow(); // advisory swallowed
    // trip listener also swallowed, but the breaker error still throws
    expect(() => engine.recordStep(spend(0.96))).toThrow(CircuitBreakerError);
  });

  it("EV-3/EV-4 event payloads carry the right discriminants and state", () => {
    const { events, onEvent } = collect();
    const engine = gated(onEvent);
    tripState(engine, spend(0.96));
    const tripped = events.find((e) => e.type === "tripped");
    expect(tripped?.type === "tripped" && tripped.reason).toBe("budget_projection");
    expect(tripped?.type === "tripped" && tripped.state.projectedCost).toBeCloseTo(0.96, 10);
  });
});

// ===========================================================================
// 7. Trip context, logging & error payload
// ===========================================================================
describe("WorthItEngine — trip context & logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("LOG-1/LOG-3 logs once on trip (default + custom logger)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new WorthItEngine({
      budgetLimit: 1.0,
      milestones: 1,
      defaultPricing: FLAT,
    });
    engine.completeMilestone();
    expect(() => engine.recordStep(spend(0.96))).toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[circuit-breaker]");

    const logger = vi.fn();
    const engine2 = new WorthItEngine({
      budgetLimit: 1.0,
      milestones: 1,
      defaultPricing: FLAT,
      logger,
    });
    engine2.completeMilestone();
    expect(() => engine2.recordStep(spend(0.96))).toThrow();
    expect(logger).toHaveBeenCalledTimes(1);
    expect((logger.mock.calls[0]?.[1] as TripContext).reason).toBe("budget_projection");
  });

  it("LOG-2/LOG-4 silent suppresses logging but still trips and emits", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { events, onEvent } = collect();
    const engine = makeEngine({ milestones: 1, onEvent });
    engine.completeMilestone();
    expect(() => engine.recordStep(spend(0.96))).toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "tripped")).toBe(true);
  });

  it("CTX-1..CTX-6 the thrown error carries full context", () => {
    const engine = makeEngine({ currency: "USD", budgetLimit: 500, milestones: 1 });
    engine.completeMilestone();
    const err = tripState(engine, { input: 20000, output: 40000 }); // cost 600
    expect(err).toBeInstanceOf(CircuitBreakerError);
    expect(err.name).toBe("CircuitBreakerError");
    expect(err.reason).toBe("budget_projection");
    expect(err.mode).toBe("worth-it");
    expect(err.metrics.iterations).toBe(1);
    expect(err.metrics.retries).toBe(0);
    expect(err.metrics.tokens.input).toBe(20000);
    expect(err.metrics.tokens.output).toBe(40000);
    expect(err.metrics.tokens.total).toBe(60000);
    expect(err.limits).toEqual({ mode: "worth-it" });
    // CTX-5: saved is negative when the projection overshoots
    expect(err.saved).toBeCloseTo(500 - 600, 10);
    expect(err.saved).toBeLessThan(0);
    expect(err.worthIt?.cumulativeCost).toBeCloseTo(600, 10);
  });

  it("CTX-7..CTX-9 message formats amounts via the currency and trip %", () => {
    const engine = makeEngine({ currency: "USD", budgetLimit: 500, milestones: 1 });
    engine.completeMilestone();
    const err = tripState(engine, { input: 20000, output: 40000 }); // cost 600
    // fmt(minor, "USD") → major (÷100) with 2 dp + code: 600 → "6.00 USD"
    expect(err.message).toContain("6.00 USD");
    expect(err.message).toContain("5.00 USD budget");
    expect(err.message).toContain("95%");
    expect(err.message).toContain("1/1 milestones");
  });

  it("CTX-9 custom tripRatio is reflected in the message percentage", () => {
    const engine = makeEngine({ milestones: 1, tripRatio: 0.8 });
    engine.completeMilestone();
    const err = tripState(engine, spend(0.85));
    expect(err.message).toContain("80%");
  });

  it("currency exponent: JPY (0 dp) formats without decimals", () => {
    const engine = makeEngine({ currency: "JPY", budgetLimit: 500, milestones: 1 });
    engine.completeMilestone();
    const err = tripState(engine, { input: 20000, output: 40000 }); // cost 600
    expect(err.message).toContain("600 JPY");
  });

  it("ER-1..ER-3 toContext round-trips and conditionally includes worthIt", () => {
    const engine = makeEngine({ milestones: 1 });
    engine.completeMilestone();
    const err = tripState(engine, spend(0.96));
    const ctx = err.toContext();
    expect(ctx.reason).toBe("budget_projection");
    expect(ctx.mode).toBe("worth-it");
    expect(ctx.worthIt).toBeDefined();
    // a non-worth-it context omits worthIt
    const plain = new CircuitBreakerError({
      reason: "max_input_tokens",
      mode: "budget-guard",
      metrics: { iterations: 1, retries: 0, tokens: { input: 1, output: 0, total: 1 } },
      limits: { mode: "budget-guard" },
      saved: 0,
      message: "x",
    });
    expect("worthIt" in plain.toContext()).toBe(false);
  });
});

// ===========================================================================
// 8. EVM / burn rate
// ===========================================================================
describe("WorthItEngine — burn rate / EVM", () => {
  it("BBR-1 returns 0 (no NaN) when progress is 0", () => {
    const engine = makeEngine({ milestones: 4 });
    const err = tripState(engine, spend(0.2)); // trips at C_proj 1.0
    expect(err.worthIt?.progress).toBe(0);
    expect(err.worthIt?.burnRate).toBe(0);
  });

  it("BBR-2 reports 1.5 when progress 50% and consumption 75%", () => {
    const engine = makeEngine({ milestones: 2 });
    engine.completeMilestone(); // progress 0.5
    const err = tripState(engine, spend(0.75)); // C_cum 0.75 → BBR 0.75/0.5
    expect(err.worthIt?.progress).toBe(0.5);
    expect(err.worthIt?.burnRate).toBeCloseTo(1.5, 10);
  });

  it("BBR-3 computes burn rate for a non-tripping step", () => {
    const engine = makeEngine({ budgetLimit: 10, milestones: 4 });
    engine.completeMilestone(2); // progress 0.5
    engine.recordStep(spend(1.0)); // consumption 1/10 = 0.1
    expect(engine.metrics.burnRate).toBeCloseTo(0.2, 10);
    expect(engine.metrics.progress).toBe(0.5);
  });

  it("BBR-4/5 on-track (=1) and ahead-of-budget (<1)", () => {
    // Build C_cum to 0.5·budget over many small steps so EMA stays low and the
    // projection never trips while consumption reaches 50% at progress 50%.
    const onTrack = makeEngine({ budgetLimit: 1000, milestones: 2 });
    onTrack.completeMilestone(); // progress 0.5
    for (let i = 0; i < 10; i++) onTrack.recordStep(spend(50)); // C_cum 500
    expect(onTrack.metrics.burnRate).toBeCloseTo(1.0, 10); // (500/1000)/0.5

    const ahead = makeEngine({ budgetLimit: 1000, milestones: 2 });
    ahead.completeMilestone(); // progress 0.5
    ahead.recordStep(spend(50)); // consumption 0.05 → BBR 0.1
    expect(ahead.metrics.burnRate).toBeCloseTo(0.1, 10);
  });

  it("BBR-6 progress 100% → BBR = C_cum / B_limit", () => {
    const engine = makeEngine({ budgetLimit: 10, milestones: 1 });
    engine.completeMilestone(); // progress 1.0
    engine.recordStep(spend(2.0));
    expect(engine.metrics.burnRate).toBeCloseTo(0.2, 10);
  });
});

// ===========================================================================
// 9. Lifecycle / reset
// ===========================================================================
describe("WorthItEngine — reset", () => {
  it("LC-1..LC-3 reset clears cost, steps, tokens, milestones and latches", () => {
    const { events, onEvent } = collect();
    const engine = makeEngine({ milestones: 1, onEvent });
    engine.completeMilestone();
    engine.recordStep(spend(0.72)); // warn + optimize? 0.72 → warn only
    expect(events.filter((e) => e.type === "predictive_warning")).toHaveLength(1);

    engine.reset();
    const m = engine.metrics;
    expect(m.steps).toBe(0);
    expect(m.cumulativeCost).toBe(0);
    expect(m.ema).toBe(0);
    expect(m.inputTokens).toBe(0);
    expect(m.outputTokens).toBe(0);
    expect(engine.progress.completedCount).toBe(0);

    engine.completeMilestone();
    engine.recordStep(spend(0.72)); // warn must fire again
    expect(events.filter((e) => e.type === "predictive_warning")).toHaveLength(2);
  });

  it("LC-4/LC-5 reset is idempotent; a re-run reproduces the first exactly", () => {
    const engine = makeEngine({ budgetLimit: 1000, alpha: 0.5, milestones: 2 });
    const first = engine.recordStep(spend(0.2));
    engine.reset();
    engine.reset(); // idempotent
    const second = engine.recordStep(spend(0.2));
    expect(second.cumulativeCost).toBeCloseTo(first.cumulativeCost, 10);
    expect(second.ema).toBeCloseTo(first.ema, 10);
    expect(second.step).toBe(1);
  });
});

// ===========================================================================
// 10. completeMilestone / setCompletedMilestones delegation
// ===========================================================================
describe("WorthItEngine — milestone delegation", () => {
  it("DEL-1/DEL-2 delegate to the ProgressTracker (and clamp)", () => {
    const engine = makeEngine({ milestones: 4 });
    engine.completeMilestone();
    expect(engine.progress.completedCount).toBe(1);
    engine.completeMilestone(2);
    expect(engine.progress.completedCount).toBe(3);
    engine.setCompletedMilestones(99);
    expect(engine.progress.completedCount).toBe(4);
  });

  it("DEL-3 progress is read at snapshot time → affects the next step only", () => {
    const engine = makeEngine({ budgetLimit: 1000, milestones: 4 });
    const s1 = engine.recordStep(spend(0.2)); // R_s = 4 at snapshot
    expect(s1.remainingSteps).toBe(4);
    engine.completeMilestone(2);
    const s2 = engine.recordStep(spend(0.2)); // now R_s = 2
    expect(s2.remainingSteps).toBe(2);
  });

  it("DEL-4 invalid args propagate the ProgressTracker TypeError", () => {
    const engine = makeEngine({ milestones: 4 });
    expect(() => engine.completeMilestone(-1)).toThrow(TypeError);
    expect(() => engine.setCompletedMilestones(1.5)).toThrow(TypeError);
  });
});

// ===========================================================================
// 11. isWorthItConfig type guard
// ===========================================================================
describe("isWorthItConfig", () => {
  it("GUARD-1/GUARD-2 narrows only on mode === 'worth-it'", () => {
    expect(isWorthItConfig({ mode: "worth-it" })).toBe(true);
    expect(isWorthItConfig({ mode: "budget-guard" })).toBe(false);
    expect(isWorthItConfig({ mode: "loop-killer" })).toBe(false);
    expect(isWorthItConfig({})).toBe(false);
    expect(isWorthItConfig({ mode: "other" })).toBe(false);
  });
});

// ===========================================================================
// 12. createWorthItRunner / WorthItRunner
// ===========================================================================
describe("createWorthItRunner", () => {
  it("RUN-1/RUN-2 wires an engine and validates config", () => {
    const runner = createWorthItRunner({
      budgetLimit: 1000,
      milestones: 3,
      defaultPricing: FLAT,
      silent: true,
    });
    expect(runner.engine).toBeInstanceOf(WorthItEngine);
    expect(runner.engine.mode).toBe("worth-it");
    expect(() => createWorthItRunner({ budgetLimit: 0, milestones: 1 })).toThrow(TypeError);
  });

  it("RUN-3..RUN-6 controls delegate and expose live metrics", () => {
    const runner = createWorthItRunner({
      budgetLimit: 1000,
      milestones: 4,
      defaultPricing: FLAT,
      silent: true,
    });
    runner.controls.completeMilestone();
    expect(runner.engine.progress.completedCount).toBe(1);
    runner.controls.completeMilestone(2);
    expect(runner.engine.progress.completedCount).toBe(3);
    runner.controls.setCompletedMilestones(4);
    expect(runner.controls.metrics.completedMilestones).toBe(4);
  });

  it("RUN-7/RUN-8 the hook runs before costing, with the native step passed through", () => {
    const seen: unknown[] = [];
    const runner = createWorthItRunner<{ id: number }>(
      { budgetLimit: 1000, milestones: 4, defaultPricing: FLAT, silent: true },
      (controls, step) => {
        seen.push(step);
        controls.completeMilestone();
      },
    );
    const nativeStep = { id: 7 };
    runner.recordStep(spend(0.2), nativeStep);
    // the projection used the post-hook progress (1 completed → R_s = 3)
    expect(runner.controls.metrics.remainingSteps).toBe(3);
    expect(runner.controls.metrics.completedMilestones).toBe(1);
    expect(seen[0]).toBe(nativeStep);
  });

  it("RUN-9 without a hook recordStep just costs the step", () => {
    const runner = createWorthItRunner({
      budgetLimit: 1000,
      milestones: 4,
      defaultPricing: FLAT,
      silent: true,
    });
    expect(() => runner.recordStep(spend(0.1), undefined)).not.toThrow();
    expect(runner.controls.metrics.steps).toBe(1);
  });

  it("RUN-10/RUN-11 the hook can prevent a trip; otherwise it propagates", () => {
    // Without advancing milestones the same usage trips.
    const tripsRunner = createWorthItRunner(
      { budgetLimit: 1.0, milestones: 4, defaultPricing: FLAT, silent: true },
      () => {},
    );
    expect(() => tripsRunner.recordStep(spend(0.2), null)).toThrow(CircuitBreakerError);

    // Advancing all milestones in the hook makes R_s = 0 → projection = cumulative → safe.
    const savedRunner = createWorthItRunner(
      { budgetLimit: 1.0, milestones: 4, defaultPricing: FLAT, silent: true },
      (controls) => controls.setCompletedMilestones(4),
    );
    expect(() => savedRunner.recordStep(spend(0.2), null)).not.toThrow();
  });
});

// ===========================================================================
// 13. Realistic end-to-end scenarios
// ===========================================================================
describe("worth-it — end-to-end scenarios", () => {
  it("E2E-1 healthy run to completion fires no events", () => {
    const { events, onEvent } = collect();
    const runner = createWorthItRunner(
      { budgetLimit: 1000, milestones: 5, defaultPricing: FLAT, silent: true, onEvent },
      (controls) => controls.completeMilestone(),
    );
    for (const c of [0.5, 0.4, 0.3, 0.2, 0.1]) runner.recordStep(spend(c), null);
    expect(events).toHaveLength(0);
    const m = runner.controls.metrics;
    expect(m.progress).toBe(1.0);
    expect(m.projectedCost).toBeCloseTo(m.cumulativeCost, 10);
    expect(m.burnRate).toBeLessThan(1.0);
  });

  it("E2E-4 trip then checkpoint-and-resume completes the run", () => {
    const engine = makeEngine({ budgetLimit: 1.0, milestones: 4 });
    expect(() => engine.recordStep(spend(0.2))).toThrow(CircuitBreakerError); // step 1 trips
    engine.completeMilestone(3); // checkpoint: advance progress
    const s2 = engine.recordStep(spend(0.05)); // recovers
    expect(s2.projectedCost).toBeLessThan(0.95);
  });

  it("E2E-5 multi-model run sums per-model costs (incl. fallbacks)", () => {
    const engine = new WorthItEngine({
      budgetLimit: 1_000_000,
      milestones: 5,
      pricing: {
        cheap: { inputPerMToken: 100, outputPerMToken: 200 },
        pricey: { inputPerMToken: 3000, outputPerMToken: 6000 },
      },
      defaultPricing: { inputPerMToken: 1000, outputPerMToken: 1000 },
      silent: true,
    });
    engine.recordStep({ input: 1000, output: 1000, model: "cheap" }); // 0.1 + 0.2 = 0.3
    engine.recordStep({ input: 1000, output: 1000, model: "pricey" }); // 3 + 6 = 9
    engine.recordStep({ input: 1000, output: 1000, model: "unknown" }); // default 1 + 1 = 2
    engine.recordStep({ input: 1000, output: 1000 }); // default 2
    expect(engine.metrics.cumulativeCost).toBeCloseTo(0.3 + 9 + 2 + 2, 10);
  });

  it("E2E-6 a cache-heavy step costs far less at a discounted cache rate", () => {
    const engine = makeEngine({
      budgetLimit: 1_000_000,
      defaultPricing: {
        inputPerMToken: 3000,
        outputPerMToken: 6000,
        cacheReadPerMToken: 300, // 10× cheaper than input
      },
    });
    const cached = engine.computeStepCost({ input: 100, output: 100, cacheReadTokens: 100_000 });
    const uncached = engine.computeStepCost({ input: 100_100, output: 100 });
    expect(cached).toBeLessThan(uncached / 5);
  });

  it("E2E-10 reset between runs reproduces the first run exactly", () => {
    const engine = makeEngine({ budgetLimit: 1.0, milestones: 4 });
    const first = tripState(engine, spend(0.2));
    engine.reset();
    const second = tripState(engine, spend(0.2));
    expect(second.worthIt?.projectedCost).toBeCloseTo(first.worthIt!.projectedCost, 10);
    expect(second.worthIt?.step).toBe(1);
  });
});

// ===========================================================================
// 14. CircuitBreaker unified entry point (worth-it mode)
// ===========================================================================
describe("CircuitBreaker (worth-it mode, unified entry point)", () => {
  it("drives worth-it through the core CircuitBreaker", () => {
    const breaker = new CircuitBreaker({
      mode: "worth-it",
      budgetLimit: 1000,
      milestones: 3,
      defaultPricing: FLAT,
      silent: true,
    });
    expect(breaker.mode).toBe("worth-it");
    breaker.completeMilestone();
    const state = breaker.recordStep({ input: 3, output: 7 }); // cost 0.10
    expect(state.stepCost).toBeCloseTo(0.1, 10);
    expect(state.completedMilestones).toBe(1);
    expect(breaker.worthItMetrics?.completedMilestones).toBe(1);
    expect(breaker.metrics.iterations).toBe(1);
    expect(breaker.metrics.tokens.input).toBe(3);
    expect(breaker.metrics.tokens.output).toBe(7);
  });

  it("trips through the core CircuitBreaker", () => {
    const breaker = new CircuitBreaker({
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: FLAT,
      silent: true,
    });
    expect(() => breaker.recordStep(spend(0.2))).toThrow(
      expect.objectContaining({ reason: "budget_projection", mode: "worth-it" }),
    );
  });

  it("rejects token/loop methods in worth-it mode", () => {
    const breaker = new CircuitBreaker({
      mode: "worth-it",
      budgetLimit: 1000,
      milestones: 1,
      defaultPricing: FLAT,
      silent: true,
    });
    expect(() => breaker.addTokens(1, 1)).toThrow(TypeError);
    expect(() => breaker.recordIteration("k")).toThrow(TypeError);
  });

  it("rejects recordStep in the token/loop modes", () => {
    const breaker = new CircuitBreaker({ silent: true });
    expect(() => breaker.recordStep({ input: 1, output: 1 })).toThrow(TypeError);
    expect(() => breaker.completeMilestone()).toThrow(TypeError);
  });

  it("still rejects a genuinely invalid mode", () => {
    expect(() => new CircuitBreaker({ mode: "nope" } as never)).toThrow(/must be/);
  });
});
