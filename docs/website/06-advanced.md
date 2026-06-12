# Advanced

## Preflight estimation

By default the breaker only checks token usage *after* each LLM call completes. To reject an oversized initial prompt *before* any provider work happens, pass `estimateInputTokens`:

```ts
import { encoding_for_model } from "js-tiktoken";
const enc = encoding_for_model("gpt-4o");

withCircuitBreaker(agent, {
  maxInputToken: 50_000,
  estimateInputTokens: (input) =>
    typeof input === "string" ? enc.encode(input).length : undefined,
});
```

If the estimate exceeds `maxInputToken`, the wrapper throws `CircuitBreakerError` with `reason: "max_input_tokens"` — no provider call is made, no tokens are billed. Return `undefined` to skip the check for that invocation (useful when you can't tokenize a given input shape).

No tokenizer is bundled. Bring whichever you prefer: `js-tiktoken`, `tiktoken`, or a provider SDK's built-in counter.

---

## Graceful handling with `onTrip`

By default the breaker throws `CircuitBreakerError`. Provide `onTrip` to suppress the throw and return a fallback value instead:

```ts
const safeAgent = withCircuitBreaker(agent, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
  onTrip: (ctx) => ({
    output: "I had to stop early — the task exceeded the token budget.",
    reason: ctx.reason,
    tokensUsed: ctx.metrics.tokens,
  }),
});

// Never throws — returns either the real result or the onTrip fallback.
const result = await safeAgent.run("...");
```

The type of `onTrip`'s return value is merged into the wrapper's return type, so TypeScript knows the result could be either the real output or the fallback.

For streaming adapters (Claude Agent SDK, LangGraph Platform SDK), the `onTrip` return value is **yielded as the final item** in the generator rather than thrown.

---

## Visibility with `onEvent`

Subscribe to events for logging, metrics, or UI feedback:

```ts
withCircuitBreaker(agent, {
  mode: "loop-killer",
  maxRetries: 3,
  onEvent(event) {
    if (event.type === "retry") {
      console.warn(`Agent looping — retry count: ${event.retries}`);
    }
    if (event.type === "stop") {
      console.error(`Breaker tripped: ${event.reason} (saved: ${event.saved})`);
    }
  },
});
```

Events fire synchronously (before the next agent call is initiated). Errors thrown inside `onEvent` are swallowed — a buggy listener never breaks the agent run.

---

## Custom logging

The default logger calls `console.warn` once when the breaker trips:

```
[circuit-breaker] Agent stopped: output token budget exceeded (10_240/10_000; iterations: 12).
```

Pass `silent: true` to suppress it, or `logger` to send the message wherever you want:

```ts
withCircuitBreaker(agent, {
  silent: true, // no log at all
});

withCircuitBreaker(agent, {
  logger: (msg, ctx) => {
    myObservabilitySDK.record("circuit_breaker_trip", {
      message: msg,
      reason: ctx.reason,
      iterations: ctx.metrics.iterations,
    });
  },
});
```