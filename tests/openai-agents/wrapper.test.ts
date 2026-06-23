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
        __turnInputFor?: (i: number) => unknown[] | undefined;
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
        const turnInput = agent.__turnInputFor?.(i) ?? [];
        this.emit("agent_start", context, agent, turnInput);
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

interface FakeAgent {
  __turns?: number;
  __tokensPerTurn?: number;
  __throw?: Error;
  __turnInputFor?: (i: number) => unknown[] | undefined;
}

const makeAgent = (cfg: FakeAgent = {}) =>
  cfg as unknown as Parameters<typeof withCircuitBreaker>[0];

describe("withCircuitBreaker (@openai/agents wrapper)", () => {
  describe("budget-guard (default mode)", () => {
    it("works with no options (10k/10k defaults)", async () => {
      const safe = withCircuitBreaker(makeAgent({ __turns: 2, __tokensPerTurn: 100 }));
      await expect(safe.run("hello")).resolves.toEqual({ finalOutput: "done" });
    });

    it("trips on max_input_tokens", async () => {
      const safe = withCircuitBreaker(
        makeAgent({ __turns: 10, __tokensPerTurn: 100 }),
        { maxInputToken: 200, maxOutputToken: 1_000_000, silent: true },
      );
      await expect(safe.run("hello")).rejects.toMatchObject({
        name: "CircuitBreakerError",
        reason: "max_input_tokens",
      });
    });

    it("trips on max_output_tokens independently", async () => {
      const safe = withCircuitBreaker(
        makeAgent({ __turns: 10, __tokensPerTurn: 100 }),
        { maxInputToken: 1_000_000, maxOutputToken: 200, silent: true },
      );
      await expect(safe.run("hello")).rejects.toMatchObject({
        reason: "max_output_tokens",
      });
    });
  });

  describe("loop-killer mode", () => {
    it("trips on repeated turnInput", async () => {
      const safe = withCircuitBreaker(
        makeAgent({
          __turns: 10,
          __tokensPerTurn: 0,
          __turnInputFor: () => [{ role: "user", content: "same input" }],
        }),
        { mode: "loop-killer", maxRetries: 2, silent: true },
      );
      await expect(safe.run("hello")).rejects.toMatchObject({
        reason: "repeated_state",
      });
    });

    it("falls back to iteration cap when detectRepeatedState=false", async () => {
      const safe = withCircuitBreaker(
        makeAgent({ __turns: 10, __tokensPerTurn: 0 }),
        {
          mode: "loop-killer",
          maxRetries: 2,
          detectRepeatedState: false,
          silent: true,
        },
      );
      await expect(safe.run("hello")).rejects.toMatchObject({
        reason: "max_retries",
      });
    });
  });

  describe("trip handling", () => {
    it("calls onTrip and returns its value when limit is hit", async () => {
      const onTrip = vi.fn().mockReturnValue({ finalOutput: "fallback" });
      const safe = withCircuitBreaker(
        makeAgent({ __turns: 10, __tokensPerTurn: 100 }),
        { maxInputToken: 50, maxOutputToken: 1_000_000, silent: true, onTrip },
      );
      const result = await safe.run("hello");
      expect(result).toEqual({ finalOutput: "fallback" });
      expect(onTrip).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });

    it("propagates non-CircuitBreaker errors unchanged", async () => {
      const safe = withCircuitBreaker(makeAgent({ __throw: new Error("upstream boom") }), {
        silent: true,
        onTrip: () => "should not be called" as never,
      });
      await expect(safe.run("hello")).rejects.toThrow("upstream boom");
    });

    it("chains an externally-supplied abort signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const safe = withCircuitBreaker(makeAgent({ __turns: 10 }), { silent: true });
      await expect(
        safe.run("hello", { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("forwards onEvent on stop", async () => {
      const onEvent = vi.fn();
      const safe = withCircuitBreaker(
        makeAgent({ __turns: 10, __tokensPerTurn: 100 }),
        {
          maxInputToken: 50,
          maxOutputToken: 1_000_000,
          silent: true,
          onEvent,
        },
      );
      await expect(safe.run("hello")).rejects.toBeInstanceOf(CircuitBreakerError);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stop", reason: "max_input_tokens" }),
      );
    });

    it("each invocation has its own counter", async () => {
      const safe = withCircuitBreaker(
        makeAgent({ __turns: 2, __tokensPerTurn: 100 }),
        { maxInputToken: 500, maxOutputToken: 500, silent: true },
      );
      await expect(safe.run("a")).resolves.toEqual({ finalOutput: "done" });
      await expect(safe.run("b")).resolves.toEqual({ finalOutput: "done" });
    });
  });

  describe("preflight (estimateInputTokens)", () => {
    it("trips before the runner emits any agent_start event", async () => {
      let agentStartCount = 0;
      const trackingAgent = {
        __turns: 5,
        __tokensPerTurn: 100,
        // counter: we expect zero because the wrapper aborts before run() begins.
        get __agentStartCount() {
          return agentStartCount;
        },
      };
      const safe = withCircuitBreaker(
        makeAgent(trackingAgent),
        {
          maxInputToken: 100,
          maxOutputToken: 100_000,
          silent: true,
          estimateInputTokens: (input) => {
            return typeof input === "string" ? input.length : 0;
          },
        },
      );
      await expect(safe.run("x".repeat(101))).rejects.toMatchObject({
        reason: "max_input_tokens",
      });
      expect(agentStartCount).toBe(0);
    });

    it("preflight routes through onTrip when provided", async () => {
      const onTrip = vi
        .fn()
        .mockReturnValue({ finalOutput: "preflight-fallback" });
      const safe = withCircuitBreaker(
        makeAgent({ __turns: 5, __tokensPerTurn: 100 }),
        {
          maxInputToken: 50,
          maxOutputToken: 100_000,
          silent: true,
          estimateInputTokens: () => 9_999,
          onTrip,
        },
      );
      await expect(safe.run("hello")).resolves.toEqual({
        finalOutput: "preflight-fallback",
      });
      expect(onTrip).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });
  });
});

describe("withCircuitBreaker (@openai/agents) — worth-it mode", () => {
  const PENNY = { inputPerMToken: 0, outputPerMToken: 10000 }; // output: 0.01/token, input free

  it("trips on projected budget overrun", async () => {
    const safe = withCircuitBreaker(makeAgent({ __turns: 10, __tokensPerTurn: 100 }), {
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: PENNY,
      silent: true,
    });
    await expect(safe.run("hello")).rejects.toMatchObject({
      reason: "budget_projection",
      mode: "worth-it",
    });
  });

  it("invokes onWorthItStep per turn", async () => {
    let calls = 0;
    const safe = withCircuitBreaker(makeAgent({ __turns: 3, __tokensPerTurn: 10 }), {
      mode: "worth-it",
      budgetLimit: 1000,
      milestones: 3,
      defaultPricing: PENNY,
      silent: true,
      onWorthItStep: (controls) => {
        calls += 1;
        controls.completeMilestone();
      },
    });
    await expect(safe.run("hello")).resolves.toEqual({ finalOutput: "done" });
    expect(calls).toBe(3);
  });

  it("routes a worth-it trip through onTrip", async () => {
    const safe = withCircuitBreaker(makeAgent({ __turns: 10, __tokensPerTurn: 100 }), {
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: PENNY,
      silent: true,
      onTrip: (ctx) => ({ finalOutput: "stopped", reason: ctx.reason }),
    });
    await expect(safe.run("hello")).resolves.toMatchObject({
      finalOutput: "stopped",
    });
  });
});
