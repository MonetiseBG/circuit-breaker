# @monetisebg/circuit-breaker

[![CI](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@monetisebg/circuit-breaker.svg)](https://www.npmjs.com/package/@monetisebg/circuit-breaker)

> One wrapper between you and runaway execution.

Minimal **circuit breaker** for AI agents. Wrap any supported agent and pick a
mode — the breaker stops the run before it burns tokens or spins in a loop.

- Zero-config: defaults work out of the box.
- Two modes, pick one: **`budget-guard`** (token caps) and **`loop-killer`**
  (state-repeat detection).
- Visible: emits `CircuitBreakerEvent`s as the run progresses.
- Typed: throws a `CircuitBreakerError`, or routes through your `onTrip` handler.
- Optional peer dependencies — only install the framework you actually use.

Shipped adapters: **LangChain.js**, **OpenAI Agents SDK**. The core is
framework-agnostic; rolling your own adapter is a few lines.

## Install

```bash
npm install @monetisebg/circuit-breaker
# plus the framework you use:
npm install @langchain/core      # for the LangChain adapter
npm install @openai/agents       # for the OpenAI Agents adapter
```

## Quick start (`budget-guard`, the default)

```ts
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/openai-agents";

const safeAgent = withCircuitBreaker(agent); // defaults: 10k input + 10k output

await safeAgent.run("Analyze this dataset");
```

`budget-guard` caps input and output tokens **independently**. Default limits:
`maxInputToken = 10_000`, `maxOutputToken = 10_000`. The breaker trips the
moment either bucket is exceeded.

```ts
withCircuitBreaker(agent, {
  mode: "budget-guard",     // optional — this is the default
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});
```

## `loop-killer` mode

```ts
withCircuitBreaker(agent, {
  mode: "loop-killer",
  maxRetries: 3,            // default
  detectRepeatedState: true,// default — hashes each step's state
});
```

With `detectRepeatedState: true` (default), the breaker hashes each step's
state (the latest message / turn input) and trips when any single state
recurs more than `maxRetries` times. Set `detectRepeatedState: false` to fall
back to a plain iteration cap.

## Visibility — `onEvent`

The breaker emits events you can log, surface in your UI, or pipe to your
observability stack.

```ts
withCircuitBreaker(agent, {
  mode: "loop-killer",
  maxRetries: 2,
  onEvent(event) {
    // event: CircuitBreakerEvent
    console.log(event);
  },
});
```

`CircuitBreakerEvent` shapes:

| Event                                               | When                          | Modes        |
| --------------------------------------------------- | ----------------------------- | ------------ |
| `{ type: "retry"; retries: number }`                | The same state recurred       | loop-killer  |
| `{ type: "stop"; reason: StopReason; saved: number }` | The breaker tripped          | both         |

`saved` is signed `limit - usage`: positive means headroom that won't be
spent, negative means the call that pushed us over the limit still counted.

`StopReason` is one of `"max_input_tokens" | "max_output_tokens" |
"max_retries" | "repeated_state"`.

## Graceful handling — `onTrip`

Provide `onTrip` to suppress the throw and return a fallback value:

```ts
const safe = withCircuitBreaker(agent, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
  onTrip: (ctx) => ({
    output: "Sorry, I had to stop early.",
    reason: ctx.reason,
    metrics: ctx.metrics,
  }),
});
```

`onTrip` receives a `TripContext`:

```ts
interface TripContext {
  reason: StopReason;
  mode: Mode;                              // "budget-guard" | "loop-killer"
  metrics: { iterations: number; retries: number; tokens: {...} };
  limits: ResolvedLimits;                  // the limits actually in force
  saved: number;
  message: string;
}
```

## LangChain.js

```ts
import { ChatOpenAI } from "@langchain/openai";
import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/langchain";

const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools });

const safeExecutor = withCircuitBreaker(executor, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});

await safeExecutor.invoke({ input: "..." });
```

Iterations are counted on `handleLLMStart` / `handleChatModelStart`. Token
usage is read from `handleLLMEnd` with provider-agnostic extraction
(OpenAI `tokenUsage`, Anthropic `usage`, newer `usage_metadata`).

## OpenAI Agents SDK

```ts
import { Agent } from "@openai/agents";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/openai-agents";

const agent = new Agent({ name: "Assistant", instructions: "...", tools });

const safeAgent = withCircuitBreaker(agent, {
  mode: "loop-killer",
  maxRetries: 3,
});

await safeAgent.run("Hello");
```

Iterations are counted on each `agent_start` event (one per turn); the most
recent `turnInput` item is hashed for loop detection. Tokens are read live
from `RunContext.usage` on each turn boundary. When a limit is hit the
wrapper aborts the in-flight run via `AbortSignal`; any caller-supplied
`signal` is chained, so external cancellation still works.

> Streaming (`stream: true`) is not yet supported. Open an issue if you need it.

## Trip output

When a limit is reached the wrapper logs and throws:

```
[circuit-breaker] Agent stopped: input token budget exceeded (10_120/10_000; iterations: 8).
```

Pass `silent: true` to suppress the log, or `logger: (msg, ctx) => …` to send
it elsewhere.

## Options reference

| Field                  | Mode         | Type        | Default    | Description                                                                  |
| ---------------------- | ------------ | ----------- | ---------- | ---------------------------------------------------------------------------- |
| `mode`                 | both         | `Mode`      | `"budget-guard"` | `"budget-guard"` or `"loop-killer"`.                                  |
| `maxInputToken`        | budget-guard | `int ≥ 1`   | `10_000`   | Max aggregate input tokens before trip.                                      |
| `maxOutputToken`       | budget-guard | `int ≥ 1`   | `10_000`   | Max aggregate output tokens before trip.                                     |
| `maxRetries`           | loop-killer  | `int ≥ 1`   | `3`        | Max times the same state may recur (or, with detection off, raw iterations). |
| `detectRepeatedState`  | loop-killer  | `boolean`   | `true`     | Hash each step's state for loop detection.                                   |
| `onEvent`              | both         | `EventListener` | —      | Receives `CircuitBreakerEvent` updates.                                      |
| `onTrip`               | wrappers     | `OnTrip<R>` | —          | Suppress the throw and use the callback's return value instead.              |

All numeric options are validated at construction; passing `0`, a negative,
`NaN`, `Infinity`, or a non-integer throws a `TypeError`.

## Contributing

See [`AGENTS.md`](./AGENTS.md) for the project layout, build/test commands,
and the recipe for adding a new framework adapter.

## License

Apache-2.0 — © 2026 MonetiseBG
