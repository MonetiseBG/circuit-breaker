import { describe, expect, it, vi } from "vitest";

import {
  CircuitBreakerError,
  withCircuitBreaker,
  type LangGraphStreamChunk,
  type RunsLike,
  type RunsStreamPayloadLike,
} from "../../src/langgraph-sdk/index.js";

interface FakeConfig {
  turns?: number;
  /** Tokens per turn, split evenly between input and output. */
  tokensPerTurn?: number;
  /** Input messages for turn `i` — return the same value to simulate a loop. */
  inputFor?: (i: number) => unknown;
  /** Throw before yielding anything. */
  throwError?: Error;
  /** Extra non-`events` chunks to emit per turn (e.g. updates/values). */
  alsoYield?: (i: number) => LangGraphStreamChunk[];
}

const abortError = (): Error => {
  const err = new Error("Aborted") as Error & { name: string };
  err.name = "AbortError";
  return err;
};

const metadata = (): LangGraphStreamChunk => ({
  event: "metadata",
  data: { run_id: "run-1", thread_id: "thread-1" },
});

const modelStart = (input: unknown): LangGraphStreamChunk => ({
  event: "events",
  data: { event: "on_chat_model_start", name: "model", data: { input } },
});

const modelEnd = (tokensPerTurn: number): LangGraphStreamChunk => ({
  event: "events",
  data: {
    event: "on_chat_model_end",
    name: "model",
    data: {
      output: {
        type: "ai",
        usage_metadata: {
          input_tokens: tokensPerTurn / 2,
          output_tokens: tokensPerTurn / 2,
          total_tokens: tokensPerTurn,
        },
      },
    },
  },
});

/**
 * Build a fake `client.runs`. The fake stream emits, per turn, an
 * `on_chat_model_start` then `on_chat_model_end` event (plus any `alsoYield`
 * chunks). `cancel` is a spy so trip-time server cancellation can be asserted.
 */
function makeRuns(cfg: FakeConfig = {}): RunsLike & {
  cancel: ReturnType<typeof vi.fn>;
  lastPayload?: RunsStreamPayloadLike;
} {
  const turns = cfg.turns ?? 5;
  const tokensPerTurn = cfg.tokensPerTurn ?? 100;
  const cancel = vi.fn().mockResolvedValue(undefined);

  const runs = {
    cancel,
    lastPayload: undefined as RunsStreamPayloadLike | undefined,
    async *stream(
      _threadId: string | null,
      _assistantId: string,
      payload?: RunsStreamPayloadLike,
    ) {
      runs.lastPayload = payload;
      if (cfg.throwError) throw cfg.throwError;
      const signal = payload?.signal;

      yield metadata();
      for (let i = 0; i < turns; i++) {
        if (signal?.aborted) throw abortError();
        const input = cfg.inputFor
          ? cfg.inputFor(i)
          : { messages: [{ type: "human", content: `turn ${i}` }] };
        yield modelStart(input);
        for (const extra of cfg.alsoYield?.(i) ?? []) yield extra;
        yield modelEnd(tokensPerTurn);
      }
    },
  };
  return runs;
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("withCircuitBreaker (@langchain/langgraph-sdk wrapper)", () => {
  describe("budget-guard (default mode)", () => {
    it("passes a clean run through untouched", async () => {
      const safe = withCircuitBreaker(makeRuns({ turns: 2, tokensPerTurn: 100 }));
      const chunks = await collect(
        safe.stream("thread-1", "agent", { input: { messages: [] } }),
      );
      // Caller didn't request `events`, so the injected events chunks are
      // consumed internally — only the metadata chunk surfaces.
      expect(chunks).toEqual([metadata()]);
    });

    it("yields events chunks when the caller requested them", async () => {
      const safe = withCircuitBreaker(makeRuns({ turns: 1, tokensPerTurn: 50 }));
      const chunks = await collect(
        safe.stream("thread-1", "agent", { streamMode: ["events"] }),
      );
      expect(chunks).toHaveLength(3); // metadata + start + end
    });

    it("trips on max_input_tokens", async () => {
      const safe = withCircuitBreaker(makeRuns({ turns: 10, tokensPerTurn: 100 }), {
        maxInputToken: 200,
        maxOutputToken: 1_000_000,
        silent: true,
      });
      await expect(
        collect(safe.stream("thread-1", "agent")),
      ).rejects.toMatchObject({
        name: "CircuitBreakerError",
        reason: "max_input_tokens",
      });
    });

    it("trips on max_output_tokens independently", async () => {
      const safe = withCircuitBreaker(makeRuns({ turns: 10, tokensPerTurn: 100 }), {
        maxInputToken: 1_000_000,
        maxOutputToken: 200,
        silent: true,
      });
      await expect(
        collect(safe.stream("thread-1", "agent")),
      ).rejects.toMatchObject({ reason: "max_output_tokens" });
    });

    it("cancels the run server-side on trip", async () => {
      const runs = makeRuns({ turns: 10, tokensPerTurn: 100 });
      const safe = withCircuitBreaker(runs, {
        maxInputToken: 200,
        maxOutputToken: 1_000_000,
        silent: true,
      });
      await expect(
        collect(safe.stream(null, "agent")),
      ).rejects.toBeInstanceOf(CircuitBreakerError);
      // thread/run ids come from the metadata event, even though threadId was null.
      expect(runs.cancel).toHaveBeenCalledWith("thread-1", "run-1");
    });

    it("forces `events` into streamMode and preserves caller modes", async () => {
      const runs = makeRuns({ turns: 1, tokensPerTurn: 0 });
      const safe = withCircuitBreaker(runs);
      await collect(safe.stream("thread-1", "agent", { streamMode: "updates" }));
      expect(runs.lastPayload?.streamMode).toEqual(["updates", "events"]);
    });
  });

  describe("loop-killer mode", () => {
    it("trips on a repeated input message", async () => {
      const safe = withCircuitBreaker(
        makeRuns({
          turns: 10,
          tokensPerTurn: 0,
          inputFor: () => ({ messages: [{ type: "human", content: "stuck" }] }),
        }),
        { mode: "loop-killer", maxRetries: 2, silent: true },
      );
      await expect(
        collect(safe.stream("thread-1", "agent")),
      ).rejects.toMatchObject({ reason: "repeated_state" });
    });

    it("falls back to iteration cap when detectRepeatedState=false", async () => {
      const safe = withCircuitBreaker(makeRuns({ turns: 10, tokensPerTurn: 0 }), {
        mode: "loop-killer",
        maxRetries: 2,
        detectRepeatedState: false,
        silent: true,
      });
      await expect(
        collect(safe.stream("thread-1", "agent")),
      ).rejects.toMatchObject({ reason: "max_retries" });
    });
  });

  describe("trip handling", () => {
    it("calls onTrip and yields its value as the final item", async () => {
      const fallback = { event: "fallback", data: null } as const;
      const onTrip = vi.fn().mockReturnValue(fallback);
      const safe = withCircuitBreaker(makeRuns({ turns: 10, tokensPerTurn: 100 }), {
        maxInputToken: 50,
        maxOutputToken: 1_000_000,
        silent: true,
        onTrip,
      });
      const chunks = await collect(safe.stream("thread-1", "agent"));
      expect(chunks.at(-1)).toBe(fallback);
      expect(onTrip).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "max_input_tokens" }),
      );
    });

    it("propagates non-CircuitBreaker errors unchanged", async () => {
      const safe = withCircuitBreaker(
        makeRuns({ throwError: new Error("upstream boom") }),
        { silent: true, onTrip: () => ({ event: "x", data: null }) },
      );
      await expect(collect(safe.stream("thread-1", "agent"))).rejects.toThrow(
        "upstream boom",
      );
    });

    it("chains an externally-supplied abort signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const safe = withCircuitBreaker(makeRuns({ turns: 10 }), { silent: true });
      await expect(
        collect(safe.stream("thread-1", "agent", { signal: controller.signal })),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("forwards onEvent on stop", async () => {
      const onEvent = vi.fn();
      const safe = withCircuitBreaker(makeRuns({ turns: 10, tokensPerTurn: 100 }), {
        maxInputToken: 50,
        maxOutputToken: 1_000_000,
        silent: true,
        onEvent,
      });
      await expect(
        collect(safe.stream("thread-1", "agent")),
      ).rejects.toBeInstanceOf(CircuitBreakerError);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stop", reason: "max_input_tokens" }),
      );
    });

    it("each stream has its own counter", async () => {
      const safe = withCircuitBreaker(makeRuns({ turns: 2, tokensPerTurn: 100 }), {
        maxInputToken: 500,
        maxOutputToken: 500,
        silent: true,
      });
      await expect(
        collect(safe.stream("thread-1", "agent")),
      ).resolves.toHaveLength(1);
      await expect(
        collect(safe.stream("thread-1", "agent")),
      ).resolves.toHaveLength(1);
    });
  });

  describe("preflight (estimateInputTokens)", () => {
    it("trips before the wrapped stream is ever consumed", async () => {
      let consumed = false;
      const runs: RunsLike = {
        async *stream() {
          consumed = true;
          yield metadata();
        },
      };
      const safe = withCircuitBreaker(runs, {
        maxInputToken: 100,
        maxOutputToken: 100_000,
        silent: true,
        estimateInputTokens: (args) => {
          const text = JSON.stringify(args.payload?.input ?? "");
          return text.length;
        },
      });
      await expect(
        collect(
          safe.stream("thread-1", "agent", {
            input: { messages: ["x".repeat(150)] },
          }),
        ),
      ).rejects.toMatchObject({ reason: "max_input_tokens" });
      expect(consumed).toBe(false);
    });
  });
});

describe("withCircuitBreaker (langgraph-sdk) — worth-it mode", () => {
  const PENNY = { inputPerMToken: 0, outputPerMToken: 10000 }; // output: 0.01/token, input free

  it("trips on projected budget overrun", async () => {
    const runs = makeRuns({ turns: 10, tokensPerTurn: 100 });
    const safe = withCircuitBreaker(runs, {
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: PENNY,
      silent: true,
    });
    await expect(
      collect(safe.stream("thread-1", "agent", { input: {} })),
    ).rejects.toMatchObject({ reason: "budget_projection", mode: "worth-it" });
  });

  it("invokes onWorthItStep per model-end event", async () => {
    let calls = 0;
    const runs = makeRuns({ turns: 3, tokensPerTurn: 10 });
    const safe = withCircuitBreaker(runs, {
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
    await collect(safe.stream("thread-1", "agent", { input: {} }));
    expect(calls).toBe(3);
  });

  it("yields onTrip fallback as the final item and cancels server-side", async () => {
    const runs = makeRuns({ turns: 10, tokensPerTurn: 100 });
    const safe = withCircuitBreaker(runs, {
      mode: "worth-it",
      budgetLimit: 1.0,
      milestones: 4,
      defaultPricing: PENNY,
      silent: true,
      onTrip: () => ({ event: "fallback", data: null }),
    });
    const chunks = await collect(safe.stream("thread-1", "agent", { input: {} }));
    expect(chunks.at(-1)).toMatchObject({ event: "fallback" });
    expect(runs.cancel).toHaveBeenCalled();
  });
});
