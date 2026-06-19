import { describe, expect, it, vi } from "vitest";

import {
  CircuitBreaker,
  CircuitBreakerError,
  type CircuitBreakerEvent,
} from "../../src/index.js";

describe("CircuitBreaker (core)", () => {
  describe("budget-guard mode", () => {
    it("is the default mode", () => {
      const breaker = new CircuitBreaker();
      expect(breaker.mode).toBe("budget-guard");
    });

    it("applies 10k/10k defaults when no limits given", () => {
      const breaker = new CircuitBreaker({ silent: true });
      breaker.addTokens(5_000, 5_000);
      expect(() => breaker.addTokens(5_001, 0)).toThrow(CircuitBreakerError);
      expect(breaker.metrics.tokens.total).toBe(15_001);
    });

    it("trips on max_input_tokens (input bucket only)", () => {
      const breaker = new CircuitBreaker({ maxInputToken: 100, maxOutputToken: 100, silent: true });
      breaker.addTokens(60, 60);
      try {
        breaker.addTokens(50, 0);
        throw new Error("unreachable");
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitBreakerError);
        const e = err as CircuitBreakerError;
        expect(e.reason).toBe("max_input_tokens");
        expect(e.mode).toBe("budget-guard");
        // saved = (100 + 100) - (110 + 60) = 30
        expect(e.saved).toBe(30);
      }
    });

    it("trips on max_output_tokens (output bucket only)", () => {
      const breaker = new CircuitBreaker({ maxInputToken: 100, maxOutputToken: 50, silent: true });
      breaker.addTokens(10, 30);
      expect(() => breaker.addTokens(10, 30)).toThrow(
        expect.objectContaining({ reason: "max_output_tokens" }),
      );
    });

    it("does not trip on iteration count", () => {
      const breaker = new CircuitBreaker({ maxInputToken: 1_000_000, maxOutputToken: 1_000_000, silent: true });
      for (let i = 0; i < 100; i++) breaker.recordIteration("k");
      expect(breaker.isTripped).toBe(false);
      expect(breaker.metrics.iterations).toBe(100);
      expect(breaker.metrics.retries).toBe(0);
    });

    it("setTokenSnapshot trips on absolute totals", () => {
      const breaker = new CircuitBreaker({ maxInputToken: 100, maxOutputToken: 100, silent: true });
      breaker.setTokenSnapshot(40, 30);
      expect(breaker.metrics.tokens.total).toBe(70);
      expect(() => breaker.setTokenSnapshot(120, 30)).toThrow(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });
  });

  describe("loop-killer mode", () => {
    it("with detectRepeatedState (default) trips when same state recurs past maxRetries", () => {
      const events: CircuitBreakerEvent[] = [];
      const breaker = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 2,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      breaker.recordIteration("same");
      breaker.recordIteration("same");
      breaker.recordIteration("same");
      expect(() => breaker.recordIteration("same")).toThrow(
        expect.objectContaining({ reason: "repeated_state" }),
      );
      expect(events.filter((e) => e.type === "retry")).toEqual([
        { type: "retry", retries: 1 },
        { type: "retry", retries: 2 },
        { type: "retry", retries: 3 },
      ]);
      const stop = events.find((e) => e.type === "stop");
      expect(stop).toMatchObject({ type: "stop", reason: "repeated_state" });
      // saved = maxRetries(2) - retries(3) = -1 (overshoot)
      expect(stop && stop.type === "stop" && stop.saved).toBe(-1);
    });

    it("does not trip when each state is distinct", () => {
      const breaker = new CircuitBreaker({ mode: "loop-killer", maxRetries: 1, silent: true });
      for (let i = 0; i < 20; i++) breaker.recordIteration(`state-${i}`);
      expect(breaker.isTripped).toBe(false);
      expect(breaker.metrics.retries).toBe(0);
    });

    it("does not record state when stateKey is undefined (detection on)", () => {
      const breaker = new CircuitBreaker({ mode: "loop-killer", maxRetries: 1, silent: true });
      for (let i = 0; i < 20; i++) breaker.recordIteration();
      expect(breaker.isTripped).toBe(false);
    });

    it("with detectRepeatedState=false falls back to iteration cap", () => {
      const breaker = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 2,
        detectRepeatedState: false,
        silent: true,
      });
      breaker.recordIteration();
      breaker.recordIteration();
      breaker.recordIteration();
      expect(() => breaker.recordIteration()).toThrow(
        expect.objectContaining({ reason: "max_retries" }),
      );
    });

    it("with detectRepeatedState=false emits retry events on each iteration past the first", () => {
      const events: CircuitBreakerEvent[] = [];
      const breaker = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 5,
        detectRepeatedState: false,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      breaker.recordIteration();
      breaker.recordIteration();
      breaker.recordIteration();
      expect(events.filter((e) => e.type === "retry")).toEqual([
        { type: "retry", retries: 1 },
        { type: "retry", retries: 2 },
      ]);
    });

    it("retry event reports per-state retry depth", () => {
      const events: CircuitBreakerEvent[] = [];
      const breaker = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 10,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      breaker.recordIteration("a");
      breaker.recordIteration("b");
      breaker.recordIteration("a");
      breaker.recordIteration("a");
      breaker.recordIteration("b");
      expect(events).toEqual([
        { type: "retry", retries: 1 }, // a repeats
        { type: "retry", retries: 2 }, // a repeats again
        { type: "retry", retries: 1 }, // b repeats
      ]);
    });

    it("does not consume tokens or trip on token usage", () => {
      const breaker = new CircuitBreaker({ mode: "loop-killer", maxRetries: 5, silent: true });
      breaker.addTokens(1_000_000, 1_000_000);
      expect(breaker.isTripped).toBe(false);
      expect(breaker.metrics.tokens.total).toBe(2_000_000);
    });
  });

  describe("lifecycle", () => {
    it("after trip, further records are no-ops (do not re-throw)", () => {
      const breaker = new CircuitBreaker({ maxInputToken: 1, maxOutputToken: 1, silent: true });
      expect(() => breaker.addTokens(2, 0)).toThrow();
      expect(() => breaker.addTokens(2, 0)).not.toThrow();
      expect(() => breaker.recordIteration()).not.toThrow();
    });

    it("logs via default logger and is silenceable", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const breaker = new CircuitBreaker({ maxInputToken: 10, maxOutputToken: 10 });
      expect(() => breaker.addTokens(20, 0)).toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/input token budget exceeded/);
      warn.mockRestore();
    });

    it("custom logger receives the full trip context", () => {
      const logger = vi.fn();
      const breaker = new CircuitBreaker({ maxInputToken: 10, maxOutputToken: 10, logger });
      expect(() => breaker.addTokens(20, 0)).toThrow();
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("input token budget"),
        expect.objectContaining({
          mode: "budget-guard",
          reason: "max_input_tokens",
          metrics: expect.objectContaining({ tokens: { input: 20, output: 0, total: 20 } }),
          saved: 0, // (10 + 10) - 20
        }),
      );
    });

    it("onEvent listener errors do not break the breaker", () => {
      const onEvent = vi.fn().mockImplementation(() => {
        throw new Error("listener boom");
      });
      const breaker = new CircuitBreaker({ maxInputToken: 5, maxOutputToken: 5, silent: true, onEvent });
      expect(() => breaker.addTokens(10, 0)).toThrow(CircuitBreakerError);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it("emits stop event with saved=limit-usage (signed)", () => {
      const events: CircuitBreakerEvent[] = [];
      const breaker = new CircuitBreaker({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      expect(() => breaker.addTokens(110, 50)).toThrow();
      expect(events).toEqual([
        { type: "stop", reason: "max_input_tokens", saved: 40 },
      ]);
    });

    it("reset() clears counters, state hashes, and untrips", () => {
      const breaker = new CircuitBreaker({ mode: "loop-killer", maxRetries: 1, silent: true });
      breaker.recordIteration("x");
      breaker.recordIteration("x");
      expect(() => breaker.recordIteration("x")).toThrow();
      breaker.reset();
      expect(breaker.isTripped).toBe(false);
      expect(breaker.metrics).toEqual({
        iterations: 0,
        retries: 0,
        tokens: { input: 0, output: 0, total: 0 },
      });
      breaker.recordIteration("x");
      breaker.recordIteration("x");
      expect(breaker.metrics.retries).toBe(1);
    });

    it("CircuitBreakerError carries reason, mode, metrics, limits, saved", () => {
      const breaker = new CircuitBreaker({ mode: "loop-killer", maxRetries: 1, silent: true });
      breaker.recordIteration("x");
      breaker.recordIteration("x");
      try {
        breaker.recordIteration("x");
        throw new Error("unreachable");
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitBreakerError);
        const e = err as CircuitBreakerError;
        expect(e.reason).toBe("repeated_state");
        expect(e.mode).toBe("loop-killer");
        expect(e.limits).toMatchObject({ mode: "loop-killer", maxRetries: 1 });
        expect(e.metrics.retries).toBe(2);
        expect(e.saved).toBe(-1);
      }
    });
  });

  describe("validation", () => {
    it("rejects non-positive-integer budget-guard limits", () => {
      expect(() => new CircuitBreaker({ maxInputToken: 0 })).toThrow(TypeError);
      expect(() => new CircuitBreaker({ maxOutputToken: -1 })).toThrow(TypeError);
      expect(() => new CircuitBreaker({ maxInputToken: 1.5 })).toThrow(
        /maxInputToken must be a positive integer/,
      );
      expect(() => new CircuitBreaker({ maxInputToken: Number.NaN })).toThrow(
        TypeError,
      );
      expect(() => new CircuitBreaker({ maxOutputToken: Infinity })).toThrow(
        TypeError,
      );
    });

    it("rejects non-positive-integer maxRetries", () => {
      expect(() => new CircuitBreaker({ mode: "loop-killer", maxRetries: 0 })).toThrow(
        TypeError,
      );
      expect(
        () => new CircuitBreaker({ mode: "loop-killer", maxRetries: 1.5 }),
      ).toThrow(/maxRetries must be a positive integer/);
    });

    it("rejects runtime mode values outside the public union", () => {
      expect(
        () => new CircuitBreaker({ mode: "invalid" } as never),
      ).toThrow(/mode must be/);
      expect(
        () => new CircuitBreaker({ mode: 42 } as never),
      ).toThrow(TypeError);
    });
  });

  describe("checkInputEstimate (preflight)", () => {
    it("trips with max_input_tokens before any addTokens call", () => {
      const breaker = new CircuitBreaker({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
      });
      expect(() => breaker.checkInputEstimate(150)).toThrow(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
      expect(breaker.isTripped).toBe(true);
    });

    it("does not trip when estimate is within budget", () => {
      const breaker = new CircuitBreaker({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
      });
      breaker.checkInputEstimate(99);
      expect(breaker.isTripped).toBe(false);
      expect(breaker.metrics.tokens.input).toBe(0);
    });

    it("no-op when mode is loop-killer", () => {
      const breaker = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 1,
        silent: true,
      });
      breaker.checkInputEstimate(1_000_000);
      expect(breaker.isTripped).toBe(false);
    });

    it("rejects invalid estimate values", () => {
      const breaker = new CircuitBreaker({ silent: true });
      expect(() => breaker.checkInputEstimate(-1)).toThrow(TypeError);
      expect(() => breaker.checkInputEstimate(Number.NaN)).toThrow(TypeError);
      expect(() => breaker.checkInputEstimate(Infinity)).toThrow(TypeError);
    });
  });
});
