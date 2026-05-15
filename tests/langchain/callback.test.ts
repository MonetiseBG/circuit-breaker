import { describe, expect, it, vi } from "vitest";
import type { LLMResult } from "@langchain/core/outputs";

import {
  CircuitBreakerCallback,
  CircuitBreakerError,
  type CircuitBreakerEvent,
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
  describe("budget-guard (default mode)", () => {
    it("trips on input token budget (OpenAI shape)", async () => {
      const cb = new CircuitBreakerCallback({ maxInputToken: 50, maxOutputToken: 100, silent: true });
      await cb.handleLLMEnd(llmEnd(40, 30), "r1");
      await expect(cb.handleLLMEnd(llmEnd(20, 0), "r2")).rejects.toMatchObject({
        reason: "max_input_tokens",
      });
    });

    it("extracts tokens from Anthropic-shaped output", async () => {
      const cb = new CircuitBreakerCallback({ maxInputToken: 25, maxOutputToken: 100, silent: true });
      await cb.handleLLMEnd(anthropicLlmEnd(20, 20), "r1");
      expect(cb.metrics.tokens.input).toBe(20);
      await expect(
        cb.handleLLMEnd(anthropicLlmEnd(10, 5), "r2"),
      ).rejects.toBeInstanceOf(CircuitBreakerError);
    });

    it("extracts tokens from usage_metadata fallback", async () => {
      const cb = new CircuitBreakerCallback({ maxInputToken: 200, maxOutputToken: 200, silent: true });
      await cb.handleLLMEnd(usageMetadataLlmEnd(30, 15), "r1");
      expect(cb.metrics.tokens).toEqual({ input: 30, output: 15, total: 45 });
    });

    it("ignores malformed token counts (string usage values)", async () => {
      const cb = new CircuitBreakerCallback({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
      });
      const malformed = {
        generations: [[]],
        llmOutput: {
          tokenUsage: {
            promptTokens: "50",
            completionTokens: "50",
          },
        },
      } as unknown as LLMResult;
      await cb.handleLLMEnd(malformed, "r1");
      expect(cb.metrics.tokens).toEqual({ input: 0, output: 0, total: 0 });
    });

    it("ignores malformed token counts (NaN, Infinity, null)", async () => {
      const cb = new CircuitBreakerCallback({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
      });
      const malformed = {
        generations: [[]],
        llmOutput: {
          usage: {
            input_tokens: Number.NaN,
            output_tokens: Infinity,
            prompt_tokens: null,
          },
        },
      } as unknown as LLMResult;
      await cb.handleLLMEnd(malformed, "r1");
      expect(cb.metrics.tokens).toEqual({ input: 0, output: 0, total: 0 });
    });

    it("ignores non-object usage payloads", async () => {
      const cb = new CircuitBreakerCallback({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
      });
      const malformed = {
        generations: [[]],
        llmOutput: { usage: "not an object" },
      } as unknown as LLMResult;
      await cb.handleLLMEnd(malformed, "r1");
      expect(cb.metrics.tokens.total).toBe(0);
    });

    it("preflight estimator on callback trips before any LLM call", async () => {
      const cb = new CircuitBreakerCallback({
        maxInputToken: 100,
        maxOutputToken: 100,
        silent: true,
      });
      expect(() => cb.checkInputEstimate(150)).toThrow(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });
  });

  describe("loop-killer mode", () => {
    it("trips on repeated last-message hash", async () => {
      const events: CircuitBreakerEvent[] = [];
      const cb = new CircuitBreakerCallback({
        mode: "loop-killer",
        maxRetries: 2,
        silent: true,
        onEvent: (e) => events.push(e),
      });
      // Simulate four turns where the most recent observation is identical.
      const messages = [[{ content: "tool result: 42" }]];
      await cb.handleChatModelStart({}, messages, "r1");
      await cb.handleChatModelStart({}, messages, "r2");
      await cb.handleChatModelStart({}, messages, "r3");
      await expect(
        cb.handleChatModelStart({}, messages, "r4"),
      ).rejects.toMatchObject({ reason: "repeated_state" });
      expect(events.some((e) => e.type === "retry")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "stop", reason: "repeated_state" });
    });

    it("falls back to handleLLMStart's last prompt for state key", async () => {
      const cb = new CircuitBreakerCallback({
        mode: "loop-killer",
        maxRetries: 1,
        silent: true,
      });
      await cb.handleLLMStart({}, ["same prompt"], "r1");
      await cb.handleLLMStart({}, ["same prompt"], "r2");
      await expect(
        cb.handleLLMStart({}, ["same prompt"], "r3"),
      ).rejects.toMatchObject({ reason: "repeated_state" });
    });

    it("does not trip when every chat input is distinct", async () => {
      const cb = new CircuitBreakerCallback({
        mode: "loop-killer",
        maxRetries: 1,
        silent: true,
      });
      for (let i = 0; i < 10; i++) {
        await cb.handleChatModelStart({}, [[{ content: `step-${i}` }]], `r${i}`);
      }
      expect(cb.metrics.iterations).toBe(10);
      expect(cb.metrics.retries).toBe(0);
    });
  });

  describe("lifecycle", () => {
    it("dedupes count across handleLLMStart + handleChatModelStart with same runId", async () => {
      const cb = new CircuitBreakerCallback({ silent: true });
      await cb.handleLLMStart({}, ["p"], "r1");
      await cb.handleChatModelStart({}, [[{ content: "p" }]], "r1");
      expect(cb.metrics.iterations).toBe(1);
    });

    it("logs via default logger when tripped and is silenceable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cb = new CircuitBreakerCallback({ maxInputToken: 1, maxOutputToken: 1 });
      await expect(cb.handleLLMEnd(llmEnd(10, 10), "r1")).rejects.toBeInstanceOf(
        CircuitBreakerError,
      );
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it("reset() clears counters and dedup state", async () => {
      const cb = new CircuitBreakerCallback({ silent: true });
      await cb.handleLLMStart({}, ["p"], "r1");
      cb.reset();
      expect(cb.metrics.iterations).toBe(0);
      await cb.handleLLMStart({}, ["p"], "r1");
      expect(cb.metrics.iterations).toBe(1);
    });

    it("does not double-trip once tripped", async () => {
      const cb = new CircuitBreakerCallback({
        maxInputToken: 1,
        maxOutputToken: 1,
        silent: true,
      });
      await expect(cb.handleLLMEnd(llmEnd(10, 10), "r1")).rejects.toBeInstanceOf(
        CircuitBreakerError,
      );
      await expect(cb.handleLLMStart({}, ["p"], "r2")).resolves.toBeUndefined();
      await expect(cb.handleLLMEnd(llmEnd(10, 10), "r2")).resolves.toBeUndefined();
    });
  });
});
