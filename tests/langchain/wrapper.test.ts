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
          await cb.handleLLMStart?.({}, [], runId);
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
  it("passes through when limits are not exceeded", async () => {
    const safe = withCircuitBreaker(fakeRunnable(2), {
      maxIterations: 5,
      silent: true,
    });
    await expect(safe.invoke({ input: "hi" })).resolves.toEqual({ output: "ok" });
  });

  it("re-throws CircuitBreakerError when iterations exceeded and no onTrip", async () => {
    const safe = withCircuitBreaker(fakeRunnable(10), {
      maxIterations: 2,
      silent: true,
    });
    await expect(safe.invoke({ input: "hi" })).rejects.toMatchObject({
      name: "CircuitBreakerError",
      reason: "max_iterations",
    });
  });

  it("re-throws on token-limit trip when no onTrip is set", async () => {
    const safe = withCircuitBreaker(fakeRunnable(10, 20), {
      maxTokens: 30,
      silent: true,
    });
    await expect(safe.invoke({ input: "hi" })).rejects.toMatchObject({
      reason: "max_tokens",
    });
  });

  it("calls onTrip with context and returns its value", async () => {
    const onTrip = vi
      .fn<(ctx: { reason: string }) => { output: string }>()
      .mockReturnValue({ output: "fallback" });
    const safe = withCircuitBreaker(fakeRunnable(10), {
      maxIterations: 2,
      silent: true,
      onTrip,
    });
    const result = await safe.invoke({ input: "hi" });
    expect(result).toEqual({ output: "fallback" });
    expect(onTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "max_iterations",
        metrics: expect.objectContaining({ iterations: 3 }),
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
      maxIterations: 5,
      silent: true,
      onTrip: () => "should not be called",
    });
    await expect(safe.invoke({ input: "x" } as never)).rejects.toThrow("boom");
  });

  it("preserves user-supplied callbacks alongside the breaker", async () => {
    const userCallback: MinimalCallback = { handleLLMStart: vi.fn(async () => {}) };
    const safe = withCircuitBreaker(fakeRunnable(3), {
      maxIterations: 10,
      silent: true,
    });
    await safe.invoke({ input: "hi" }, { callbacks: [userCallback] });
    expect(userCallback.handleLLMStart).toHaveBeenCalledTimes(3);
  });

  it("uses a fresh counter for each invocation", async () => {
    const safe = withCircuitBreaker(fakeRunnable(2), {
      maxIterations: 3,
      silent: true,
    });
    await expect(safe.invoke({ input: "1" })).resolves.toEqual({ output: "ok" });
    await expect(safe.invoke({ input: "2" })).resolves.toEqual({ output: "ok" });
  });

  it("exposes CircuitBreakerError as instanceof check", async () => {
    const safe = withCircuitBreaker(fakeRunnable(10), {
      maxIterations: 1,
      silent: true,
    });
    try {
      await safe.invoke({ input: "x" });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerError);
    }
  });
});
