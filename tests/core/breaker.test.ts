import { describe, expect, it, vi } from "vitest";

import { CircuitBreaker, CircuitBreakerError } from "../../src/index.js";

describe("CircuitBreaker (core)", () => {
  it("trips on iteration overflow", () => {
    const b = new CircuitBreaker({ maxIterations: 2, silent: true });
    b.recordIteration();
    b.recordIteration();
    expect(() => b.recordIteration()).toThrow(CircuitBreakerError);
    expect(b.metrics.iterations).toBe(3);
    expect(b.isTripped).toBe(true);
  });

  it("trips on token overflow via addTokens (deltas)", () => {
    const b = new CircuitBreaker({ maxTokens: 50, silent: true });
    b.addTokens(20, 20);
    expect(() => b.addTokens(10, 10)).toThrow(CircuitBreakerError);
    expect(b.metrics.tokens.total).toBe(60);
  });

  it("trips on token overflow via setTokenSnapshot (absolute)", () => {
    const b = new CircuitBreaker({ maxTokens: 100, silent: true });
    b.setTokenSnapshot(40, 30);
    expect(b.metrics.tokens.total).toBe(70);
    expect(() => b.setTokenSnapshot(80, 30)).toThrow(CircuitBreakerError);
  });

  it("after trip, further records are no-ops (do not re-throw)", () => {
    const b = new CircuitBreaker({ maxIterations: 1, silent: true });
    b.recordIteration();
    expect(() => b.recordIteration()).toThrow();
    expect(() => b.recordIteration()).not.toThrow();
    expect(() => b.addTokens(10, 10)).not.toThrow();
  });

  it("logs via default logger and is silenceable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = new CircuitBreaker({ maxIterations: 1 });
    b.recordIteration();
    expect(() => b.recordIteration()).toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/iteration limit \(2\/1/);
    warn.mockRestore();
  });

  it("custom logger receives context", () => {
    const logger = vi.fn();
    const b = new CircuitBreaker({ maxTokens: 10, logger });
    expect(() => b.addTokens(20, 0)).toThrow();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("token limit"),
      expect.objectContaining({
        reason: "max_tokens",
        metrics: expect.objectContaining({
          tokens: { input: 20, output: 0, total: 20 },
        }),
        limits: { maxIterations: undefined, maxTokens: 10 },
      }),
    );
  });

  it("validates options at construction", () => {
    expect(() => new CircuitBreaker({})).toThrow(TypeError);
    expect(() => new CircuitBreaker({ maxIterations: 0 })).toThrow(TypeError);
    expect(() => new CircuitBreaker({ maxTokens: -1 })).toThrow(TypeError);
    expect(() => new CircuitBreaker({ maxIterations: Number.NaN })).toThrow(
      TypeError,
    );
    expect(() => new CircuitBreaker({ maxIterations: Infinity })).toThrow(
      TypeError,
    );
  });

  it("rejects non-integer limits (must be positive integers)", () => {
    expect(() => new CircuitBreaker({ maxIterations: 1.5 })).toThrow(
      /maxIterations must be a positive integer/,
    );
    expect(() => new CircuitBreaker({ maxTokens: 100.1 })).toThrow(
      /maxTokens must be a positive integer/,
    );
    expect(() => new CircuitBreaker({ maxTokens: 0.5 })).toThrow(TypeError);
    // Sanity: a legal integer still works.
    expect(() => new CircuitBreaker({ maxIterations: 1, maxTokens: 1 })).not.toThrow();
  });

  it("reset() clears counters and untrips", () => {
    const b = new CircuitBreaker({ maxIterations: 1, silent: true });
    b.recordIteration();
    expect(() => b.recordIteration()).toThrow();
    b.reset();
    expect(b.isTripped).toBe(false);
    expect(b.metrics.iterations).toBe(0);
    b.recordIteration();
    expect(b.metrics.iterations).toBe(1);
  });

  it("error carries reason, metrics, limits", () => {
    const b = new CircuitBreaker({ maxIterations: 1, maxTokens: 100, silent: true });
    b.recordIteration();
    try {
      b.recordIteration();
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerError);
      const e = err as CircuitBreakerError;
      expect(e.reason).toBe("max_iterations");
      expect(e.limits).toEqual({ maxIterations: 1, maxTokens: 100 });
      expect(e.metrics.iterations).toBe(2);
    }
  });
});
