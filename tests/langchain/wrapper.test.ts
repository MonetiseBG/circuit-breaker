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
