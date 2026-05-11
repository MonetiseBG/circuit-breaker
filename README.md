# @monetisebg/circuit-breaker

[![CI](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@monetisebg/circuit-breaker.svg)](https://www.npmjs.com/package/@monetisebg/circuit-breaker)

Minimal **circuit breaker** for AI agents. Stop an agent run after a
configurable number of iterations or once it has burned more tokens than you
allow — with one line of setup.

Shared decision core, per-framework wrappers. Today: **LangChain.js** and
**OpenAI Agents SDK**. Bring your own framework by reusing the core.

- Zero-config wrapper around any supported agent runtime.
- Two limits, pick one or both: `maxIterations`, `maxTokens`.
- Logs a clear reason on trip (`console.warn`) with iteration / token summary.
- Throws a typed `CircuitBreakerError` (or routes through your `onTrip` handler).
- Optional peer dependencies — only install the framework you actually use.

## Install

```bash
npm install @monetisebg/circuit-breaker
# plus the framework(s) you use:
npm install @langchain/core      # for the LangChain adapter
npm install @openai/agents       # for the OpenAI Agents adapter
```

## LangChain.js

```ts
import { ChatOpenAI } from "@langchain/openai";
import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/langchain";

const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools });

const safeExecutor = withCircuitBreaker(executor, {
  maxIterations: 10,    // stop after 10 LLM calls
  maxTokens: 50_000,    // ...or 50k total tokens, whichever first
});

const result = await safeExecutor.invoke({ input: "..." });
```

Counts iterations on each `handleLLMStart` / `handleChatModelStart` and reads
token usage from `handleLLMEnd`. Provider-agnostic token extraction: OpenAI
(`tokenUsage`), Anthropic (`usage`), and the newer `usage_metadata` shape.

## OpenAI Agents SDK

```ts
import { Agent } from "@openai/agents";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/openai-agents";

const agent = new Agent({ name: "Assistant", instructions: "...", tools });

const safeAgent = withCircuitBreaker(agent, {
  maxIterations: 10,
  maxTokens: 50_000,
});

const result = await safeAgent.run("Hello");
```

Counts iterations on each `agent_start` event (one per turn) and reads token
usage live from `RunContext.usage` on each turn boundary. When a limit is hit
the wrapper aborts the in-flight run via `AbortSignal`; any caller-supplied
`signal` is chained, so external cancellation still works.

> Streaming (`stream: true`) is not yet supported. Open an issue if you need it.

## Trip output

When a limit is reached the wrapper logs and throws:

```
[circuit-breaker] Agent stopped: reached iteration limit (11/10 iterations; tokens used: 8421).
```

## Graceful handling (`onTrip`)

Provide `onTrip` to suppress the throw and return your own fallback value:

```ts
const safe = withCircuitBreaker(executor, {
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

## Low-level: core class

If you'd rather drive the breaker yourself (e.g. for a framework we don't
ship an adapter for), the core class is exported from the package root:

```ts
import { CircuitBreaker, CircuitBreakerError } from "@monetisebg/circuit-breaker";

const breaker = new CircuitBreaker({ maxIterations: 10, maxTokens: 50_000 });

// On every LLM call / agent turn:
breaker.recordIteration();

// When you see per-call usage:
breaker.addTokens(inputTokens, outputTokens);

// Or when your framework gives you a running total:
breaker.setTokenSnapshot(totalIn, totalOut);

// Read state any time:
breaker.metrics; // { iterations, tokens: { input, output, total } }
```

Each call will throw `CircuitBreakerError` when a limit is exceeded.

## Options

| Option          | Type                | Description                                                                |
|-----------------|---------------------|----------------------------------------------------------------------------|
| `maxIterations` | `number`            | Max LLM calls / agent turns allowed. Trips on the `n+1`th.                 |
| `maxTokens`     | `number`            | Max total tokens (input + output) summed across calls.                     |
| `silent`        | `boolean`           | Suppress the default `console.warn`. Default: `false`.                     |
| `logger`        | `(msg, ctx) => void`| Replace the default logger. Ignored if `silent` is true.                   |
| `onTrip`        | `(ctx) => R`        | *(wrappers only)* Suppress the throw and return `R` instead.               |
| `runConfig`     | `Partial<RunConfig>`| *(@openai/agents only)* Forwarded to the internal `Runner`.                |

At least one of `maxIterations` / `maxTokens` must be provided.

## Token extraction (LangChain)

The breaker reads token usage from `LLMResult.llmOutput` and falls back through:

1. `llmOutput.tokenUsage` — OpenAI shape (`promptTokens` / `completionTokens`).
2. `llmOutput.usage` — Anthropic / snake_case (`input_tokens` / `output_tokens`).
3. `generations[0][i].message.usage_metadata` — newer LangChain message shape.

If your provider exposes usage in a different field, token-based tripping will
be a no-op for it (iteration-based tripping still works). Open an issue with
the shape and we'll add it.

## Contributing

See [`AGENTS.md`](./AGENTS.md) for the project layout, build/test commands,
and the recipe for adding a new framework adapter.

## License

MIT — © MonetiseBG
