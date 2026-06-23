import { describe, expect, it, vi } from "vitest";

import {
  CircuitBreakerError,
  withCircuitBreaker,
  type QueryFn,
  type QueryParams,
} from "../../src/claude-agent-sdk/index.js";

interface FakeConfig {
  turns?: number;
  /** Tokens per turn, split evenly between input and output. */
  tokensPerTurn?: number;
  /** Content blocks for turn `i` — return the same value to simulate a loop. */
  contentFor?: (i: number) => unknown;
  /** Throw before yielding anything. */
  throwError?: Error;
}

const abortError = (): Error => {
  const err = new Error("Aborted") as Error & { name: string };
  err.name = "AbortError";
  return err;
};

const assistant = (content: unknown, tokensPerTurn: number) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content,
    usage: {
      input_tokens: tokensPerTurn / 2,
      output_tokens: tokensPerTurn / 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
  parent_tool_use_id: null,
  uuid: "uuid",
  session_id: "session",
});

function makeQuery(cfg: FakeConfig = {}): QueryFn {
  const turns = cfg.turns ?? 5;
  const tokensPerTurn = cfg.tokensPerTurn ?? 100;

  async function* run(params: QueryParams) {
    if (cfg.throwError) throw cfg.throwError;
    const signal = params.options?.abortController?.signal;

    for (let i = 0; i < turns; i++) {
      if (signal?.aborted) throw abortError();
      const content = cfg.contentFor
        ? cfg.contentFor(i)
        : [{ type: "text", text: `turn ${i}` }];
      yield assistant(content, tokensPerTurn);
    }
    yield {
      type: "result",
      subtype: "success",
      result: "done",
      uuid: "uuid-result",
      session_id: "session",
    };
  }

  return run as unknown as QueryFn;
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("withCircuitBreaker (@anthropic-ai/claude-agent-sdk wrapper)", () => {
  describe("budget-guard (default mode)", () => {
    it("works with no options (10k/10k defaults)", async () => {
      const safe = withCircuitBreaker(
        makeQuery({ turns: 2, tokensPerTurn: 100 }),
      );
      const messages = await collect(safe({ prompt: "hello" }));
      expect(messages.at(-1)).toMatchObject({ type: "result" });
    });

    it("trips on max_input_tokens", async () => {
      const safe = withCircuitBreaker(
        makeQuery({ turns: 10, tokensPerTurn: 100 }),
        { maxInputToken: 200, maxOutputToken: 1_000_000, silent: true },
      );
      await expect(collect(safe({ prompt: "hello" }))).rejects.toMatchObject({
        name: "CircuitBreakerError",
        reason: "max_input_tokens",
      });
    });

    it("trips on max_output_tokens independently", async () => {
      const safe = withCircuitBreaker(
        makeQuery({ turns: 10, tokensPerTurn: 100 }),
        { maxInputToken: 1_000_000, maxOutputToken: 200, silent: true },
      );
      await expect(collect(safe({ prompt: "hello" }))).rejects.toMatchObject({
        reason: "max_output_tokens",
      });
    });

    it("counts cache tokens toward the input budget", async () => {
      async function* run() {
        yield assistant([{ type: "text", text: "hi" }], 0);
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            usage: {
              input_tokens: 50,
              output_tokens: 0,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 100,
            },
          },
          parent_tool_use_id: null,
          uuid: "uuid-1",
          session_id: "session",
        };
      }
      const safe = withCircuitBreaker(run as unknown as QueryFn, {
        maxInputToken: 200,
        maxOutputToken: 1_000_000,
        silent: true,
      });
      await expect(collect(safe({ prompt: "hello" }))).rejects.toMatchObject({
        reason: "max_input_tokens",
      });
    });
  });

  describe("loop-killer mode", () => {
    it("trips on repeated assistant content", async () => {
      const safe = withCircuitBreaker(
        makeQuery({
          turns: 10,
          tokensPerTurn: 0,
          contentFor: () => [{ type: "text", text: "same content" }],
        }),
        { mode: "loop-killer", maxRetries: 2, silent: true },
      );
      await expect(collect(safe({ prompt: "hello" }))).rejects.toMatchObject({
        reason: "repeated_state",
      });
    });

    it("falls back to iteration cap when detectRepeatedState=false", async () => {
      const safe = withCircuitBreaker(
        makeQuery({ turns: 10, tokensPerTurn: 0 }),
        {
          mode: "loop-killer",
          maxRetries: 2,
          detectRepeatedState: false,
          silent: true,
        },
      );
      await expect(collect(safe({ prompt: "hello" }))).rejects.toMatchObject({
        reason: "max_retries",
      });
    });
  });

  describe("trip handling", () => {
    it("calls onTrip and yields its value as the final item", async () => {
      const fallback = { type: "result", subtype: "fallback" } as const;
      const onTrip = vi.fn().mockReturnValue(fallback);
      const safe = withCircuitBreaker(
        makeQuery({ turns: 10, tokensPerTurn: 100 }),
        { maxInputToken: 50, maxOutputToken: 1_000_000, silent: true, onTrip },
      );
      const messages = await collect(safe({ prompt: "hello" }));
      expect(messages.at(-1)).toBe(fallback);
      expect(onTrip).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });

    it("propagates non-CircuitBreaker errors unchanged", async () => {
      const safe = withCircuitBreaker(
        makeQuery({ throwError: new Error("upstream boom") }),
        { silent: true, onTrip: () => "should not be called" as never },
      );
      await expect(collect(safe({ prompt: "hello" }))).rejects.toThrow(
        "upstream boom",
      );
    });

    it("chains an externally-supplied abort signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const safe = withCircuitBreaker(makeQuery({ turns: 10 }), {
        silent: true,
      });
      await expect(
        collect(
          safe({ prompt: "hello", options: { abortController: controller } }),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("forwards onEvent on stop", async () => {
      const onEvent = vi.fn();
      const safe = withCircuitBreaker(
        makeQuery({ turns: 10, tokensPerTurn: 100 }),
        {
          maxInputToken: 50,
          maxOutputToken: 1_000_000,
          silent: true,
          onEvent,
        },
      );
      await expect(collect(safe({ prompt: "hello" }))).rejects.toBeInstanceOf(
        CircuitBreakerError,
      );
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stop", reason: "max_input_tokens" }),
      );
    });

    it("each invocation has its own counter", async () => {
      const safe = withCircuitBreaker(
        makeQuery({ turns: 2, tokensPerTurn: 100 }),
        { maxInputToken: 500, maxOutputToken: 500, silent: true },
      );
      await expect(collect(safe({ prompt: "a" }))).resolves.toHaveLength(3);
      await expect(collect(safe({ prompt: "b" }))).resolves.toHaveLength(3);
    });
  });

  describe("preflight (estimateInputTokens)", () => {
    it("trips before the wrapped query is ever consumed", async () => {
      let consumed = false;
      const tracking: QueryFn = (async function* () {
        consumed = true;
        yield assistant([{ type: "text", text: "x" }], 0);
      }) as unknown as QueryFn;

      const safe = withCircuitBreaker(tracking, {
        maxInputToken: 100,
        maxOutputToken: 100_000,
        silent: true,
        estimateInputTokens: (params) => {
          return typeof params.prompt === "string" ? params.prompt.length : 0;
        },
      });

      await expect(
        collect(safe({ prompt: "x".repeat(150) })),
      ).rejects.toMatchObject({ reason: "max_input_tokens" });
      expect(consumed).toBe(false);
    });

    it("preflight routes through onTrip when provided", async () => {
      const fallback = { type: "result", subtype: "preflight-fallback" } as const;
      const onTrip = vi.fn().mockReturnValue(fallback);
      const safe = withCircuitBreaker(
        makeQuery({ turns: 5, tokensPerTurn: 100 }),
        {
          maxInputToken: 50,
          maxOutputToken: 100_000,
          silent: true,
          estimateInputTokens: () => 9_999,
          onTrip,
        },
      );
      const messages = await collect(safe({ prompt: "hello" }));
      expect(messages).toEqual([fallback]);
      expect(onTrip).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });
  });
});

describe("withCircuitBreaker (claude-agent-sdk) — worth-it mode", () => {
  const PENNY = { inputPerMToken: 0, outputPerMToken: 10000 }; // output: 0.01/token, input free

  it("trips on projected budget overrun", async () => {
    const safe = withCircuitBreaker(makeQuery({ turns: 10, tokensPerTurn: 100 }), {
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: PENNY,
      silent: true,
    });
    await expect(collect(safe({ prompt: "hello" }))).rejects.toMatchObject({
      reason: "budget_projection",
      mode: "worth-it",
    });
  });

  it("invokes onWorthItStep per assistant turn", async () => {
    let calls = 0;
    const safe = withCircuitBreaker(makeQuery({ turns: 3, tokensPerTurn: 10 }), {
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
    const msgs = await collect(safe({ prompt: "hello" }));
    expect(msgs.at(-1)).toMatchObject({ type: "result" });
    expect(calls).toBe(3);
  });

  it("yields onTrip fallback as the final item", async () => {
    const safe = withCircuitBreaker(makeQuery({ turns: 10, tokensPerTurn: 100 }), {
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: PENNY,
      silent: true,
      onTrip: () => ({ type: "result", subtype: "stopped" }),
    });
    const msgs = await collect(safe({ prompt: "hello" }));
    expect(msgs.at(-1)).toMatchObject({ subtype: "stopped" });
  });
});
