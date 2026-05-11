# @monetisebg/circuit-breaker

Minimal **circuit breaker** for LangChain.js agents. Stop an agent run after a
configurable number of iterations or once it has burned more tokens than you
allow — with one line of setup.

- Zero-config wrapper around any LangChain `Runnable` (e.g. `AgentExecutor`).
- Two limits, pick one or both: `maxIterations`, `maxTokens`.
- Logs a clear reason on trip (`console.warn`) with iteration / token summary.
- Throws a typed `CircuitBreakerError` (or routes through your `onTrip` handler).
- Provider-agnostic token extraction (OpenAI / Anthropic / `usage_metadata`).

## Install

```bash
npm install @monetisebg/circuit-breaker
# peer dependency:
npm install @langchain/core
```

## Quick start (wrapper)

```ts
import { ChatOpenAI } from "@langchain/openai";
import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker";

const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools });

const safeExecutor = withCircuitBreaker(executor, {
  maxIterations: 10,    // stop after 10 LLM calls
  maxTokens: 50_000,    // ...or 50k total tokens, whichever first
});

const result = await safeExecutor.invoke({ input: "..." });
```

When a limit is reached the wrapper logs and throws:

```
[circuit-breaker] Agent stopped: reached iteration limit (11/10 iterations; tokens used: 8421).
```

## Graceful handling (`onTrip`)

Provide `onTrip` to suppress the throw and return your own fallback value:

```ts
const safeExecutor = withCircuitBreaker(executor, {
  maxIterations: 10,
  maxTokens: 50_000,
  onTrip: (ctx) => ({
    output: "Sorry, I had to stop early.",
    stoppedReason: ctx.reason,    // "max_iterations" | "max_tokens"
    usage: ctx.metrics.tokens,
  }),
});
```

`onTrip` receives:

```ts
interface TripContext {
  reason: "max_iterations" | "max_tokens";
  metrics: {
    iterations: number;
    tokens: { input: number; output: number; total: number };
  };
  limits: { maxIterations?: number; maxTokens?: number };
  message: string;
}
```

## Low-level: callback only

If you'd rather not wrap, attach the callback handler yourself:

```ts
import { CircuitBreakerCallback, CircuitBreakerError } from "@monetisebg/circuit-breaker";

const breaker = new CircuitBreakerCallback({ maxIterations: 10, maxTokens: 50_000 });

try {
  await executor.invoke({ input }, { callbacks: [breaker] });
} catch (err) {
  if (err instanceof CircuitBreakerError) {
    console.error(err.reason, err.metrics, err.limits);
  } else {
    throw err;
  }
}
```

> Each `CircuitBreakerCallback` instance carries counters across one
> invocation. Create a new instance per call, or call `breaker.reset()`.
> The `withCircuitBreaker` wrapper does this for you.

## Options

| Option          | Type                | Description                                                                |
|-----------------|---------------------|----------------------------------------------------------------------------|
| `maxIterations` | `number`            | Max LLM calls allowed. Trips on the `n+1`th call.                          |
| `maxTokens`     | `number`            | Max total tokens (input + output) summed across calls.                     |
| `silent`        | `boolean`           | Suppress the default `console.warn`. Default: `false`.                     |
| `logger`        | `(msg, ctx) => void`| Replace the default logger. Ignored if `silent` is true.                   |
| `onTrip`        | `(ctx) => R`        | *(wrapper only)* Suppress the throw and return `R` instead.                |

At least one of `maxIterations` / `maxTokens` must be provided.

## Token extraction

The breaker reads token usage from `LLMResult.llmOutput` and falls back through:

1. `llmOutput.tokenUsage` — OpenAI shape (`promptTokens` / `completionTokens`).
2. `llmOutput.usage` — Anthropic / snake_case (`input_tokens` / `output_tokens`).
3. `generations[0][i].message.usage_metadata` — newer LangChain message shape.

If your provider exposes usage in a different field, token-based tripping will
be a no-op for it (iteration-based tripping still works). Open an issue with
the shape and we'll add it.

## License

MIT
