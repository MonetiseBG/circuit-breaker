import { describe, expect, it, vi } from "vitest";

import {
  CircuitBreaker,
  CircuitBreakerError,
  type CircuitBreakerEvent,
} from "../../src/index.js";

describe("CircuitBreaker (core)", () => {
  describe("budget-guard mode", () => {
    it("is the default mode", () => {
      const b = new CircuitBreaker();
      expect(b.mode).toBe("budget-guard");
    });

    it("applies 10k/10k defaults when no limits given", () => {
      const b = new CircuitBreaker({ silent: true });
      b.addTokens(5_000, 5_000);
      expect(() => b.addTokens(5_001, 0)).toThrow(CircuitBreakerError);
      expect(b.metrics.tokens.total).toBe(15_001);
    });

    it("trips on max_input_tokens (input bucket only)", () => {
      const b = new CircuitBreaker({ maxInputToken: 100, maxOutputToken: 100, silent: true });
      b.addTokens(60, 60);
      try {
        b.addTokens(50, 0);
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
      const b = new CircuitBreaker({ maxInputToken: 100, maxOutputToken: 50, silent: true });
      b.addTokens(10, 30);
      expect(() => b.addTokens(10, 30)).toThrow(
        expect.objectContaining({ reason: "max_output_tokens" }),
      );
    });

    it("does not trip on iteration count", () => {
      const b = new CircuitBreaker({ maxInputToken: 1_000_000, maxOutputToken: 1_000_000, silent: true });
      for (let i = 0; i < 100; i++) b.recordIteration("k");
      expect(b.isTripped).toBe(false);
      expect(b.metrics.iterations).toBe(100);
      expect(b.metrics.retries).toBe(0);
    });

    it("setTokenSnapshot trips on absolute totals", () => {
      const b = new CircuitBreaker({ maxInputToken: 100, maxOutputToken: 100, silent: true });
      b.setTokenSnapshot(40, 30);
      expect(b.metrics.tokens.total).toBe(70);
      expect(() => b.setTokenSnapshot(120, 30)).toThrow(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });
  });

  describe("loop-killer mode", () => {
    it("with detectRepeatedState (default) trips when same state recurs past maxRetries", () => {
      const events: CircuitBreakerEvent[] = [];
      const b = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 2,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      b.recordIteration("same");
      b.recordIteration("same");
      b.recordIteration("same");
      expect(() => b.recordIteration("same")).toThrow(
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
      const b = new CircuitBreaker({ mode: "loop-killer", maxRetries: 1, silent: true });
      for (let i = 0; i < 20; i++) b.recordIteration(`state-${i}`);
      expect(b.isTripped).toBe(false);
      expect(b.metrics.retries).toBe(0);
    });

    it("does not record state when stateKey is undefined (detection on)", () => {
      const b = new CircuitBreaker({ mode: "loop-killer", maxRetries: 1, silent: true });
      for (let i = 0; i < 20; i++) b.recordIteration();
      expect(b.isTripped).toBe(false);
    });

    it("with detectRepeatedState=false falls back to iteration cap", () => {
      const b = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 2,
        detectRepeatedState: false,
        silent: true,
      });
      b.recordIteration();
      b.recordIteration();
      b.recordIteration();
      expect(() => b.recordIteration()).toThrow(
        expect.objectContaining({ reason: "max_retries" }),
      );
    });

    it("with detectRepeatedState=false emits retry events on each iteration past the first", () => {
      const events: CircuitBreakerEvent[] = [];
      const b = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 5,
        detectRepeatedState: false,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      b.recordIteration();
      b.recordIteration();
      b.recordIteration();
      expect(events.filter((e) => e.type === "retry")).toEqual([
        { type: "retry", retries: 1 },
        { type: "retry", retries: 2 },
      ]);
    });

    it("retry event reports per-state retry depth", () => {
      const events: CircuitBreakerEvent[] = [];
      const b = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 10,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      b.recordIteration("a");
      b.recordIteration("b");
      b.recordIteration("a");
      b.recordIteration("a");
      b.recordIteration("b");
      expect(events).toEqual([
        { type: "retry", retries: 1 }, // a repeats
        { type: "retry", retries: 2 }, // a repeats again
        { type: "retry", retries: 1 }, // b repeats
      ]);
    });

    it("does not consume tokens or trip on token usage", () => {
      const b = new CircuitBreaker({ mode: "loop-killer", maxRetries: 5, silent: true });
      b.addTokens(1_000_000, 1_000_000);
      expect(b.isTripped).toBe(false);
      expect(b.metrics.tokens.total).toBe(2_000_000);
    });
  });

  describe("lifecycle", () => {
    it("after trip, further records are no-ops (do not re-throw)", () => {
      const b = new CircuitBreaker({ maxInputToken: 1, maxOutputToken: 1, silent: true });
      expect(() => b.addTokens(2, 0)).toThrow();
      expect(() => b.addTokens(2, 0)).not.toThrow();
      expect(() => b.recordIteration()).not.toThrow();
    });

    it("logs via default logger and is silenceable", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const b = new CircuitBreaker({ maxInputToken: 10, maxOutputToken: 10 });
      expect(() => b.addTokens(20, 0)).toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/input token budget exceeded/);
      warn.mockRestore();
    });

    it("custom logger receives the full trip context", () => {
      const logger = vi.fn();
      const b = new CircuitBreaker({ maxInputToken: 10, maxOutputToken: 10, logger });
      expect(() => b.addTokens(20, 0)).toThrow();
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
      const b = new CircuitBreaker({ maxInputToken: 5, maxOutputToken: 5, silent: true, onEvent });
      expect(() => b.addTokens(10, 0)).toThrow(CircuitBreakerError);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it("emits stop event with saved=limit-usage (signed)", () => {
      const events: CircuitBreakerEvent[] = [];
      const b = new CircuitBreaker({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      expect(() => b.addTokens(110, 50)).toThrow();
      expect(events).toEqual([
        { type: "stop", reason: "max_input_tokens", saved: 40 },
      ]);
    });

    it("reset() clears counters, state hashes, and untrips", () => {
      const b = new CircuitBreaker({ mode: "loop-killer", maxRetries: 1, silent: true });
      b.recordIteration("x");
      b.recordIteration("x");
      expect(() => b.recordIteration("x")).toThrow();
      b.reset();
      expect(b.isTripped).toBe(false);
      expect(b.metrics).toEqual({
        iterations: 0,
        retries: 0,
        tokens: { input: 0, output: 0, total: 0 },
      });
      b.recordIteration("x");
      b.recordIteration("x");
      expect(b.metrics.retries).toBe(1);
    });

    it("CircuitBreakerError carries reason, mode, metrics, limits, saved", () => {
      const b = new CircuitBreaker({ mode: "loop-killer", maxRetries: 1, silent: true });
      b.recordIteration("x");
      b.recordIteration("x");
      try {
        b.recordIteration("x");
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
      ).toThrow(/mode must be "budget-guard" or "loop-killer"/);
      expect(
        () => new CircuitBreaker({ mode: 42 } as never),
      ).toThrow(TypeError);
    });
  });

  describe("checkInputEstimate (preflight)", () => {
    it("trips with max_input_tokens before any addTokens call", () => {
      const b = new CircuitBreaker({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
      });
      expect(() => b.checkInputEstimate(150)).toThrow(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
      expect(b.isTripped).toBe(true);
    });

    it("does not trip when estimate is within budget", () => {
      const b = new CircuitBreaker({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
      });
      b.checkInputEstimate(99);
      expect(b.isTripped).toBe(false);
      expect(b.metrics.tokens.input).toBe(0);
    });

    it("no-op when mode is loop-killer", () => {
      const b = new CircuitBreaker({
        mode: "loop-killer",
        maxRetries: 1,
        silent: true,
      });
      b.checkInputEstimate(1_000_000);
      expect(b.isTripped).toBe(false);
    });

    it("rejects invalid estimate values", () => {
      const b = new CircuitBreaker({ silent: true });
      expect(() => b.checkInputEstimate(-1)).toThrow(TypeError);
      expect(() => b.checkInputEstimate(Number.NaN)).toThrow(TypeError);
      expect(() => b.checkInputEstimate(Infinity)).toThrow(TypeError);
    });
  });
});
