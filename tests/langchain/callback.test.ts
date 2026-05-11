import { describe, expect, it, vi } from "vitest";
import type { LLMResult } from "@langchain/core/outputs";

import {
  CircuitBreakerCallback,
  CircuitBreakerError,
} from "../../src/langchain/index.js";

const llmEnd = (input: number, output: number): LLMResult => ({
  generations: [[]],
  llmOutput: {
    tokenUsage: {
      promptTokens: input,
      completionTokens: output,
      totalTokens: input + output,
    },
  },
});

const anthropicLlmEnd = (input: number, output: number): LLMResult => ({
  generations: [[]],
  llmOutput: { usage: { input_tokens: input, output_tokens: output } },
});

const usageMetadataLlmEnd = (input: number, output: number): LLMResult => ({
  generations: [
    [
      {
        text: "",
        message: { usage_metadata: { input_tokens: input, output_tokens: output } },
      } as never,
    ],
  ],
});

describe("CircuitBreakerCallback (LangChain adapter)", () => {
  it("trips after maxIterations LLM starts", async () => {
    const cb = new CircuitBreakerCallback({ maxIterations: 2, silent: true });
    await cb.handleLLMStart({}, [], "r1");
    await cb.handleLLMStart({}, [], "r2");
    await expect(cb.handleLLMStart({}, [], "r3")).rejects.toBeInstanceOf(
      CircuitBreakerError,
    );
    expect(cb.metrics.iterations).toBe(3);
  });

  it("trips after maxTokens accumulated (OpenAI shape)", async () => {
    const cb = new CircuitBreakerCallback({ maxTokens: 100, silent: true });
    await cb.handleLLMEnd(llmEnd(40, 30), "r1");
    await expect(cb.handleLLMEnd(llmEnd(50, 0), "r2")).rejects.toMatchObject({
      reason: "max_tokens",
    });
  });

  it("extracts tokens from Anthropic-shaped output", async () => {
    const cb = new CircuitBreakerCallback({ maxTokens: 50, silent: true });
    await cb.handleLLMEnd(anthropicLlmEnd(20, 20), "r1");
    expect(cb.metrics.tokens.total).toBe(40);
    await expect(
      cb.handleLLMEnd(anthropicLlmEnd(10, 5), "r2"),
    ).rejects.toBeInstanceOf(CircuitBreakerError);
  });

  it("extracts tokens from usage_metadata fallback", async () => {
    const cb = new CircuitBreakerCallback({ maxTokens: 200, silent: true });
    await cb.handleLLMEnd(usageMetadataLlmEnd(30, 15), "r1");
    expect(cb.metrics.tokens).toEqual({ input: 30, output: 15, total: 45 });
  });

  it("logs via default logger when tripped and is silenceable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cb = new CircuitBreakerCallback({ maxIterations: 1 });
    await cb.handleLLMStart({}, [], "r1");
    await expect(cb.handleLLMStart({}, [], "r2")).rejects.toBeInstanceOf(
      CircuitBreakerError,
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/iteration limit \(2\/1/);
    warn.mockRestore();
  });

  it("dedupes count across handleLLMStart + handleChatModelStart with same runId", async () => {
    const cb = new CircuitBreakerCallback({ maxIterations: 5, silent: true });
    await cb.handleLLMStart({}, [], "r1");
    await cb.handleChatModelStart({}, [], "r1");
    expect(cb.metrics.iterations).toBe(1);
  });

  it("reset() clears counters and dedup state", async () => {
    const cb = new CircuitBreakerCallback({ maxIterations: 2, silent: true });
    await cb.handleLLMStart({}, [], "r1");
    cb.reset();
    expect(cb.metrics.iterations).toBe(0);
    await cb.handleLLMStart({}, [], "r1");
    expect(cb.metrics.iterations).toBe(1);
  });

  it("does not double-trip once tripped", async () => {
    const cb = new CircuitBreakerCallback({ maxIterations: 1, silent: true });
    await cb.handleLLMStart({}, [], "r1");
    await expect(cb.handleLLMStart({}, [], "r2")).rejects.toBeInstanceOf(
      CircuitBreakerError,
    );
    await expect(cb.handleLLMStart({}, [], "r3")).resolves.toBeUndefined();
    await expect(cb.handleLLMEnd(llmEnd(10, 10), "r3")).resolves.toBeUndefined();
  });
});
