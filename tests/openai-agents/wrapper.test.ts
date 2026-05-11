import { describe, expect, it, vi } from "vitest";

vi.mock("@openai/agents", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeRunner extends EventEmitter {
    constructor(public readonly config?: unknown) {
      super();
    }

    async run(
      agent: {
        __turns?: number;
        __tokensPerTurn?: number;
        __throw?: Error;
      },
      _input: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<{ finalOutput: string }> {
      if (agent.__throw) throw agent.__throw;

      const signal = options?.signal;
      const turns = agent.__turns ?? 5;
      const tokensPerTurn = agent.__tokensPerTurn ?? 100;
      const usage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requests: 0,
      };
      const context = { usage };

      const ensureNotAborted = () => {
        if (signal?.aborted) {
          const err = new Error("Aborted") as Error & { name: string };
          err.name = "AbortError";
          throw err;
        }
      };

      for (let i = 0; i < turns; i++) {
        ensureNotAborted();
        this.emit("agent_start", context, agent, []);
        ensureNotAborted();

        usage.inputTokens += tokensPerTurn / 2;
        usage.outputTokens += tokensPerTurn / 2;
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
        usage.requests += 1;

        this.emit("agent_end", context, agent, "step output");
        ensureNotAborted();
      }
      return { finalOutput: "done" };
    }
  }

  return { Runner: FakeRunner };
});

import {
  CircuitBreakerError,
  withCircuitBreaker,
} from "../../src/openai-agents/index.js";

// Tests use a structural stand-in for an Agent; the wrapper never inspects it
// beyond forwarding to Runner.run().
const makeAgent = (turns = 5, tokensPerTurn = 100, throwErr?: Error) =>
  ({
    __turns: turns,
    __tokensPerTurn: tokensPerTurn,
    __throw: throwErr,
  }) as unknown as Parameters<typeof withCircuitBreaker>[0];

describe("withCircuitBreaker (@openai/agents wrapper)", () => {
  it("passes through when limits are not exceeded", async () => {
    const safe = withCircuitBreaker(makeAgent(2, 100), {
      maxIterations: 5,
      maxTokens: 10_000,
      silent: true,
    });
    await expect(safe.run("hello")).resolves.toEqual({ finalOutput: "done" });
  });

  it("trips on iteration limit and re-throws CircuitBreakerError", async () => {
    const safe = withCircuitBreaker(makeAgent(10, 50), {
      maxIterations: 2,
      silent: true,
    });
    await expect(safe.run("hello")).rejects.toMatchObject({
      name: "CircuitBreakerError",
      reason: "max_iterations",
    });
  });

  it("trips on token limit and re-throws CircuitBreakerError", async () => {
    const safe = withCircuitBreaker(makeAgent(10, 100), {
      maxTokens: 150,
      silent: true,
    });
    await expect(safe.run("hello")).rejects.toMatchObject({
      name: "CircuitBreakerError",
      reason: "max_tokens",
    });
  });

  it("calls onTrip and returns its value when limit is hit", async () => {
    const onTrip = vi.fn().mockReturnValue({ finalOutput: "fallback" });
    const safe = withCircuitBreaker(makeAgent(10), {
      maxIterations: 1,
      silent: true,
      onTrip,
    });
    const result = await safe.run("hello");
    expect(result).toEqual({ finalOutput: "fallback" });
    expect(onTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "max_iterations",
        metrics: expect.objectContaining({ iterations: 2 }),
      }),
    );
  });

  it("propagates non-CircuitBreaker errors unchanged", async () => {
    const safe = withCircuitBreaker(makeAgent(0, 0, new Error("upstream boom")), {
      maxIterations: 10,
      silent: true,
      onTrip: () => "should not be called" as never,
    });
    await expect(safe.run("hello")).rejects.toThrow("upstream boom");
  });

  it("chains an externally-supplied abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const safe = withCircuitBreaker(makeAgent(10), {
      maxIterations: 10,
      silent: true,
    });
    await expect(
      safe.run("hello", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("each invocation has its own counter", async () => {
    const safe = withCircuitBreaker(makeAgent(2, 100), {
      maxIterations: 3,
      silent: true,
    });
    await expect(safe.run("a")).resolves.toEqual({ finalOutput: "done" });
    await expect(safe.run("b")).resolves.toEqual({ finalOutput: "done" });
  });

  it("instanceof check works for thrown error", async () => {
    const safe = withCircuitBreaker(makeAgent(10), {
      maxIterations: 1,
      silent: true,
    });
    try {
      await safe.run("hello");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerError);
    }
  });
});
