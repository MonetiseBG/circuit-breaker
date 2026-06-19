import { describe, expect, it, vi } from "vitest";
import type { LLMResult } from "@langchain/core/outputs";

import {
  CircuitBreakerError,
  withCircuitBreaker,
} from "../../src/langchain/index.js";

interface MinimalCallback {
  handleLLMStart?: (llm: unknown, prompts: string[], runId: string) => Promise<void>;
  handleLLMEnd?: (output: LLMResult, runId: string) => Promise<void>;
}

function fakeRunnable(steps: number, tokensPerCall = 20) {
  return {
    async invoke(
      _input: { input: string },
      config?: { callbacks?: MinimalCallback[] },
    ): Promise<{ output: string }> {
      const callbacks = config?.callbacks ?? [];
      for (let i = 0; i < steps; i++) {
        const runId = `run-${i}`;
        for (const cb of callbacks) {
          await cb.handleLLMStart?.({}, [`prompt-${i}`], runId);
          await cb.handleLLMEnd?.(
            {
              generations: [[]],
              llmOutput: {
                tokenUsage: {
                  promptTokens: tokensPerCall / 2,
                  completionTokens: tokensPerCall / 2,
                  totalTokens: tokensPerCall,
                },
              },
            },
            runId,
          );
        }
      }
      return { output: "ok" };
    },
  };
}

describe("withCircuitBreaker (LangChain wrapper)", () => {
  it("works with no options (budget-guard defaults)", async () => {
    const safe = withCircuitBreaker(fakeRunnable(2));
    await expect(safe.invoke({ input: "hi" })).resolves.toEqual({ output: "ok" });
  });

  it("re-throws CircuitBreakerError when token budget exceeded and no onTrip", async () => {
    const safe = withCircuitBreaker(fakeRunnable(10, 100), {
      maxInputToken: 200,
      maxOutputToken: 1_000_000,
      silent: true,
    });
    await expect(safe.invoke({ input: "hi" })).rejects.toMatchObject({
      name: "CircuitBreakerError",
      reason: "max_input_tokens",
    });
  });

  it("calls onTrip with context and returns its value", async () => {
    const onTrip = vi
      .fn<(ctx: { reason: string }) => { output: string }>()
      .mockReturnValue({ output: "fallback" });
    const safe = withCircuitBreaker(fakeRunnable(10, 100), {
      maxInputToken: 100,
      maxOutputToken: 1_000_000,
      silent: true,
      onTrip,
    });
    const result = await safe.invoke({ input: "hi" });
    expect(result).toEqual({ output: "fallback" });
    expect(onTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "max_input_tokens",
        mode: "budget-guard",
      }),
    );
  });

  it("propagates non-CircuitBreaker errors", async () => {
    const failing = {
      async invoke(): Promise<never> {
        throw new Error("boom");
      },
    };
    const safe = withCircuitBreaker(failing, {
      silent: true,
      onTrip: () => "should not be called",
    });
    await expect(safe.invoke({ input: "x" } as never)).rejects.toThrow("boom");
  });

  it("preserves user-supplied callbacks alongside the breaker", async () => {
    const userCallback: MinimalCallback = { handleLLMStart: vi.fn(async () => {}) };
    const safe = withCircuitBreaker(fakeRunnable(3), { silent: true });
    await safe.invoke({ input: "hi" }, { callbacks: [userCallback] });
    expect(userCallback.handleLLMStart).toHaveBeenCalledTimes(3);
  });

  it("uses a fresh breaker for each invocation", async () => {
    const safe = withCircuitBreaker(fakeRunnable(2, 50), {
      maxInputToken: 100,
      maxOutputToken: 100,
      silent: true,
    });
    await expect(safe.invoke({ input: "1" })).resolves.toEqual({ output: "ok" });
    await expect(safe.invoke({ input: "2" })).resolves.toEqual({ output: "ok" });
  });

  it("forwards onEvent to the underlying breaker", async () => {
    const onEvent = vi.fn();
    const safe = withCircuitBreaker(fakeRunnable(10, 100), {
      maxInputToken: 200,
      maxOutputToken: 1_000_000,
      silent: true,
      onEvent,
    });
    await expect(safe.invoke({ input: "x" })).rejects.toBeInstanceOf(
      CircuitBreakerError,
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stop", reason: "max_input_tokens" }),
    );
  });

  it("preflight estimator trips before the runnable is invoked", async () => {
    const invoke = vi.fn(async () => ({ output: "should not run" }));
    const runnable = { invoke };
    const safe = withCircuitBreaker(runnable, {
      maxInputToken: 100,
      maxOutputToken: 100,
      silent: true,
      estimateInputTokens: (input) => {
        // input is typed as the runnable's input — exercise the generic.
        return (input as { input: string }).input.length;
      },
    });
    const oversized = "x".repeat(101);
    await expect(safe.invoke({ input: oversized })).rejects.toMatchObject({
      reason: "max_input_tokens",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preflight estimator returning undefined skips the check", async () => {
    const invoke = vi.fn(async () => ({ output: "ok" }));
    const runnable = { invoke };
    const safe = withCircuitBreaker(runnable, {
      maxInputToken: 10,
      maxOutputToken: 10,
      silent: true,
      estimateInputTokens: () => undefined,
    });
    await expect(safe.invoke({ input: "x" } as never)).resolves.toEqual({
      output: "ok",
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("preflight trip routes through onTrip when provided", async () => {
    const invoke = vi.fn(async () => ({ output: "should not run" }));
    const onTrip = vi.fn().mockReturnValue({ output: "fallback" });
    const safe = withCircuitBreaker(
      { invoke },
      {
        maxInputToken: 100,
        silent: true,
        estimateInputTokens: () => 9_999,
        onTrip,
      },
    );
    await expect(safe.invoke({ input: "x" } as never)).resolves.toEqual({
      output: "fallback",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(onTrip).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "max_input_tokens" }),
    );
  });

  it("loop-killer trips on repeated prompts across calls", async () => {
    // Runnable that always sends the same prompt on every iteration.
    const loopingRunnable = {
      async invoke(
        _input: { input: string },
        config?: { callbacks?: MinimalCallback[] },
      ): Promise<{ output: string }> {
        for (let i = 0; i < 20; i++) {
          for (const cb of config?.callbacks ?? []) {
            await cb.handleLLMStart?.({}, ["the same prompt"], `r${i}`);
          }
        }
        return { output: "ok" };
      },
    };
    const safe = withCircuitBreaker(loopingRunnable, {
      mode: "loop-killer",
      maxRetries: 2,
      silent: true,
    });
    await expect(safe.invoke({ input: "x" })).rejects.toMatchObject({
      reason: "repeated_state",
    });
  });
});

describe("withCircuitBreaker (LangChain) — worth-it mode", () => {
  const PENNY = { inputPerMToken: 0, outputPerMToken: 10000 }; // output: 0.01/token, input free

  it("trips on projected budget overrun", async () => {
    const safe = withCircuitBreaker(fakeRunnable(10, 100), {
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: PENNY,
      silent: true,
    });
    await expect(safe.invoke({ input: "hi" })).rejects.toMatchObject({
      reason: "budget_projection",
      mode: "worth-it",
    });
  });

  it("invokes onWorthItStep per LLM call", async () => {
    let calls = 0;
    const safe = withCircuitBreaker(fakeRunnable(3, 10), {
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
    await expect(safe.invoke({ input: "hi" })).resolves.toEqual({ output: "ok" });
    expect(calls).toBe(3);
  });

  it("routes a worth-it trip through onTrip", async () => {
    const safe = withCircuitBreaker(fakeRunnable(10, 100), {
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: PENNY,
      silent: true,
      onTrip: (ctx) => ({ output: "fallback", reason: ctx.reason }),
    });
    await expect(safe.invoke({ input: "hi" })).resolves.toMatchObject({
      output: "fallback",
    });
  });
});
