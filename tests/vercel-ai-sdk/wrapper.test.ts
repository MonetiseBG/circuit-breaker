import { describe, expect, it, vi } from "vitest";

import {
  CircuitBreakerError,
  withCircuitBreaker,
  type GenerateTextFn,
  type GenerateTextOptions,
} from "../../src/vercel-ai-sdk/index.js";

const abortError = (): Error => {
  const err = new Error("Aborted") as Error & { name: string };
  err.name = "AbortError";
  return err;
};

interface FakeConfig {
  steps?: number;
  /** Tokens per step, split evenly between input and output. */
  tokensPerStep?: number;
  /** Tool calls for step `i` — return the same value to simulate a loop. */
  toolCallsFor?: (i: number) => unknown[];
  /** Text for step `i`. */
  textFor?: (i: number) => string;
  /** Throw before producing any step. */
  throwError?: Error;
  /** Observe whether the wrapped function was ever entered. */
  onEnter?: () => void;
}

function makeStep(
  i: number,
  tokensPerStep: number,
  toolCalls: unknown[],
  text: string,
) {
  return {
    stepNumber: i,
    content: [{ type: "text", text }],
    text,
    toolCalls,
    toolResults: [],
    finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
    usage: {
      inputTokens: tokensPerStep / 2,
      outputTokens: tokensPerStep / 2,
      totalTokens: tokensPerStep,
    },
  };
}

function makeGenerateText(cfg: FakeConfig = {}): GenerateTextFn {
  const steps = cfg.steps ?? 5;
  const tokensPerStep = cfg.tokensPerStep ?? 100;

  const fn = async (options: GenerateTextOptions) => {
    cfg.onEnter?.();
    if (cfg.throwError) throw cfg.throwError;
    const signal = options.abortSignal;
    const collected: unknown[] = [];

    for (let i = 0; i < steps; i++) {
      if (signal?.aborted) throw abortError();
      const toolCalls = cfg.toolCallsFor ? cfg.toolCallsFor(i) : [];
      const text = cfg.textFor ? cfg.textFor(i) : `step ${i}`;
      const step = makeStep(i, tokensPerStep, toolCalls, text);
      collected.push(step);
      await options.onStepFinish?.(step as never);
    }

    return {
      text: "done",
      steps: collected,
      finishReason: "stop",
      usage: {
        inputTokens: (steps * tokensPerStep) / 2,
        outputTokens: (steps * tokensPerStep) / 2,
        totalTokens: steps * tokensPerStep,
      },
    };
  };

  return fn as unknown as GenerateTextFn;
}

const callOpts = (extra?: Partial<GenerateTextOptions>): GenerateTextOptions =>
  ({ model: "test-model", prompt: "hello", ...extra }) as GenerateTextOptions;

describe("withCircuitBreaker (ai / Vercel AI SDK wrapper)", () => {
  describe("budget-guard (default mode)", () => {
    it("works with no options (10k/10k defaults)", async () => {
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 2, tokensPerStep: 100 }),
      );
      const result = await safe(callOpts());
      expect(result).toMatchObject({ text: "done" });
    });

    it("trips on max_input_tokens", async () => {
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 10, tokensPerStep: 100 }),
        { maxInputToken: 200, maxOutputToken: 1_000_000, silent: true },
      );
      await expect(safe(callOpts())).rejects.toMatchObject({
        name: "CircuitBreakerError",
        reason: "max_input_tokens",
      });
    });

    it("trips on max_output_tokens independently", async () => {
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 10, tokensPerStep: 100 }),
        { maxInputToken: 1_000_000, maxOutputToken: 200, silent: true },
      );
      await expect(safe(callOpts())).rejects.toMatchObject({
        reason: "max_output_tokens",
      });
    });

    it("surfaces a trip on the final step (nothing left to abort)", async () => {
      // 2 steps of 100 in, limit 150: the breaker trips on step 2's
      // onStepFinish, after which the fake loop ends with no further call to
      // abort — the wrapper must still surface the trip post-return.
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 2, tokensPerStep: 200 }),
        { maxInputToken: 150, maxOutputToken: 1_000_000, silent: true },
      );
      await expect(safe(callOpts())).rejects.toMatchObject({
        reason: "max_input_tokens",
      });
    });
  });

  describe("loop-killer mode", () => {
    it("trips on repeated tool calls", async () => {
      const safe = withCircuitBreaker(
        makeGenerateText({
          steps: 10,
          tokensPerStep: 0,
          toolCallsFor: () => [{ toolName: "search", input: { q: "same" } }],
        }),
        { mode: "loop-killer", maxRetries: 2, silent: true },
      );
      await expect(safe(callOpts())).rejects.toMatchObject({
        reason: "repeated_state",
      });
    });

    it("falls back to iteration cap when detectRepeatedState=false", async () => {
      const safe = withCircuitBreaker(
        makeGenerateText({
          steps: 10,
          tokensPerStep: 0,
          textFor: (i) => `unique ${i}`,
        }),
        {
          mode: "loop-killer",
          maxRetries: 2,
          detectRepeatedState: false,
          silent: true,
        },
      );
      await expect(safe(callOpts())).rejects.toMatchObject({
        reason: "max_retries",
      });
    });
  });

  describe("trip handling", () => {
    it("calls onTrip and returns its value as the result", async () => {
      const fallback = { text: "fallback", steps: [] } as const;
      const onTrip = vi.fn().mockReturnValue(fallback);
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 10, tokensPerStep: 100 }),
        { maxInputToken: 50, maxOutputToken: 1_000_000, silent: true, onTrip },
      );
      const result = await safe(callOpts());
      expect(result).toBe(fallback);
      expect(onTrip).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });

    it("propagates non-CircuitBreaker errors unchanged", async () => {
      const safe = withCircuitBreaker(
        makeGenerateText({ throwError: new Error("upstream boom") }),
        { silent: true, onTrip: () => "should not be called" as never },
      );
      await expect(safe(callOpts())).rejects.toThrow("upstream boom");
    });

    it("chains an externally-supplied abort signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const safe = withCircuitBreaker(makeGenerateText({ steps: 10 }), {
        silent: true,
      });
      await expect(
        safe(callOpts({ abortSignal: controller.signal })),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("forwards onEvent on stop", async () => {
      const onEvent = vi.fn();
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 10, tokensPerStep: 100 }),
        { maxInputToken: 50, maxOutputToken: 1_000_000, silent: true, onEvent },
      );
      await expect(safe(callOpts())).rejects.toBeInstanceOf(CircuitBreakerError);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stop", reason: "max_input_tokens" }),
      );
    });

    it("still invokes a caller-supplied onStepFinish", async () => {
      const userStep = vi.fn();
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 3, tokensPerStep: 10 }),
        { maxInputToken: 1_000_000, maxOutputToken: 1_000_000, silent: true },
      );
      await safe(callOpts({ onStepFinish: userStep }));
      expect(userStep).toHaveBeenCalledTimes(3);
    });

    it("each invocation has its own counter", async () => {
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 2, tokensPerStep: 100 }),
        { maxInputToken: 500, maxOutputToken: 500, silent: true },
      );
      await expect(safe(callOpts({ prompt: "a" }))).resolves.toMatchObject({
        text: "done",
      });
      await expect(safe(callOpts({ prompt: "b" }))).resolves.toMatchObject({
        text: "done",
      });
    });
  });

  describe("preflight (estimateInputTokens)", () => {
    it("trips before the wrapped function is ever entered", async () => {
      let entered = false;
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 5, onEnter: () => (entered = true) }),
        {
          maxInputToken: 100,
          maxOutputToken: 100_000,
          silent: true,
          estimateInputTokens: (opts) =>
            typeof opts.prompt === "string" ? opts.prompt.length : 0,
        },
      );

      await expect(
        safe(callOpts({ prompt: "x".repeat(150) })),
      ).rejects.toMatchObject({ reason: "max_input_tokens" });
      expect(entered).toBe(false);
    });

    it("preflight routes through onTrip when provided", async () => {
      const fallback = { text: "preflight-fallback", steps: [] } as const;
      const onTrip = vi.fn().mockReturnValue(fallback);
      const safe = withCircuitBreaker(
        makeGenerateText({ steps: 5, tokensPerStep: 100 }),
        {
          maxInputToken: 50,
          maxOutputToken: 100_000,
          silent: true,
          estimateInputTokens: () => 9_999,
          onTrip,
        },
      );
      const result = await safe(callOpts());
      expect(result).toBe(fallback);
      expect(onTrip).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });
  });
});
