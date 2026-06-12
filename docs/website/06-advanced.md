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

---

## Building your own adapter

The package root exports the framework-agnostic `CircuitBreaker` core. If your framework isn't listed, here's the pattern:

### 1. Create your adapter

```ts
import { CircuitBreaker, CircuitBreakerError } from "@monetisebg/circuit-breaker";
import type { CircuitBreakerOptions } from "@monetisebg/circuit-breaker";

export function withCircuitBreaker<T>(
  myFrameworkTarget: T,
  options: CircuitBreakerOptions = {},
): WrappedT {
  return {
    async run(input) {
      const breaker = new CircuitBreaker(options);

      // Preflight (optional)
      if (options.estimateInputTokens) {
        const est = options.estimateInputTokens(input);
        if (est !== undefined) breaker.checkInputEstimate(est);
      }

      // Hook into your framework's lifecycle:
      myFramework.onStepStart((step) => {
        breaker.recordIteration(step.stateKey); // throws CircuitBreakerError if tripped
      });

      myFramework.onStepEnd((step) => {
        breaker.addTokens(step.inputTokens, step.outputTokens); // or setTokenSnapshot
      });

      try {
        return await myFrameworkTarget.run(input);
      } catch (err) {
        if (err instanceof CircuitBreakerError && options.onTrip) {
          return options.onTrip(err) as Result;
        }
        throw err;
      }
    },
  };
}
```

### 2. Map framework events to core primitives

| When | Core call |
|---|---|
| Each new LLM call / agent step starts | `breaker.recordIteration(stateKey?)` |
| Per-call token deltas are available | `breaker.addTokens(inputDelta, outputDelta)` |
| Framework exposes running totals | `breaker.setTokenSnapshot(totalIn, totalOut)` |

Pass a `stateKey` (a string derived from the step's input — latest message, tool call args, etc.) so `loop-killer` mode can detect repetition. The core handles hashing.

### 3. Decide how to abort

- **`AbortSignal`-aware frameworks** (OpenAI Agents SDK, Vercel AI SDK): catch the `CircuitBreakerError` from your callback, signal an `AbortController`, and re-throw.
- **Callback-propagating frameworks** (LangChain): throw `CircuitBreakerError` directly from inside the callback — the framework propagates it to the caller.
- **Generator-based frameworks** (Claude Agent SDK, LangGraph SDK): `return` from the generator (after optionally yielding the `onTrip` result).

### 4. Add to `package.json` and `tsup.config.ts`

If you're contributing the adapter back to the repo, add your framework as an optional peer dep and a new entry point. See [Contributing](./07-contributing.md).
