# @monetisebg/circuit-breaker

[![CI](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@monetisebg/circuit-breaker.svg)](https://www.npmjs.com/package/@monetisebg/circuit-breaker)

> One wrapper between you and runaway execution.

Minimal **circuit breaker** for AI agents. Wrap any supported agent and pick a
mode — the breaker cuts the run short once provider-reported usage crosses a
limit, and (optionally) refuses an oversized prompt before it is even sent.

- Zero-config: defaults work out of the box.
- Two modes, pick one: **`budget-guard`** (token caps) and **`loop-killer`**
  (state-repeat detection).
- Post-hoc enforcement by default: token tripping happens **after** each call
  or turn boundary, so the call that crosses the limit still counts. Use the
  optional `estimateInputTokens` preflight (see below) to reject oversized
  initial inputs before any provider work happens.
- Visible: emits `CircuitBreakerEvent`s as the run progresses.
- Typed: throws a `CircuitBreakerError`, or routes through your `onTrip` handler.
- Optional peer dependencies — only install the framework you actually use.
- No bundled tokenizer: bring your own (`js-tiktoken`, `tiktoken`, provider SDK).

Shipped adapters: **LangChain.js**, **OpenAI Agents SDK**, **Claude Agent
SDK**, **Vercel AI SDK**, **LangGraph Platform SDK**. The core is
framework-agnostic; rolling your own adapter is a few lines.


[Watch the 1-minute overview](https://www.youtube.com/watch?v=nhRmZBkjeFU) — see how Circuit Breaker stops a runaway agent in real time.
  
[![Circuit Breaker — 1-min explainer](https://img.youtube.com/vi/nhRmZBkjeFU/1.jpg)](https://www.youtube.com/watch?v=nhRmZBkjeFU)


## Install

Requires **Node ≥ 22** (the breaker uses `node:crypto`).

```bash
npm install @monetisebg/circuit-breaker
# plus the framework you use (minimum versions enforced via peerDependencies):
npm install @langchain/core@^1.1.47              # for the LangChain adapter
npm install @openai/agents@^0.11.0               # for the OpenAI Agents adapter
npm install @anthropic-ai/claude-agent-sdk@^0.2  # for the Claude Agent SDK adapter
npm install ai@^5                                 # for the Vercel AI SDK adapter
npm install @langchain/langgraph-sdk@^1           # for the LangGraph Platform SDK adapter
```

## Quick start (`budget-guard`, the default)

```ts
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/openai-agents";

const safeAgent = withCircuitBreaker(agent); // defaults: 10k input + 10k output

await safeAgent.run("Analyze this dataset");
```

`budget-guard` caps input and output tokens **independently**. Default limits:
`maxInputToken = 10_000`, `maxOutputToken = 10_000`. Token usage is read from
each provider response, so the breaker trips on the **next** call/turn after
either bucket is exceeded — the call that pushed the bucket over the limit
still counts. To reject an oversized first prompt before it is sent, pass an
optional `estimateInputTokens` preflight (next section).

```ts
withCircuitBreaker(agent, {
  mode: "budget-guard",     // optional — this is the default
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});
```

### Preflight — `estimateInputTokens`

```ts
import { encoding_for_model } from "js-tiktoken";
const enc = encoding_for_model("gpt-4o");

withCircuitBreaker(agent, {
  maxInputToken: 50_000,
  // input is the wrapper's call argument (typed per adapter)
  estimateInputTokens: (input) =>
    typeof input === "string" ? enc.encode(input).length : undefined,
});
```

If the estimate exceeds `maxInputToken` the wrapper throws
`CircuitBreakerError` with `reason: "max_input_tokens"` **before** the
underlying runnable / runner / query is called. Return `undefined` to skip
the check for that invocation (e.g. when you can't tokenize the input shape).
This is opt-in — without an estimator the wrapper behaves as before. No
tokenizer is bundled.

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

| Event                                                 | When                                              | Modes        |
| ----------------------------------------------------- | ------------------------------------------------- | ------------ |
| `{ type: "retry"; retries: number }`                  | A state recurred (`detectRepeatedState: true`) or each iteration past the first (`detectRepeatedState: false`) | loop-killer  |
| `{ type: "stop"; reason: StopReason; saved: number }` | The breaker tripped                               | both         |

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

## Claude Agent SDK

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/claude-agent-sdk";

const safeQuery = withCircuitBreaker(query, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});

for await (const message of safeQuery({ prompt: "Analyze this repo" })) {
  // messages stream through untouched
}
```

The wrapper takes the SDK's `query` function and returns a drop-in
replacement with the same call signature. It's itself an async generator —
`SDKMessage`s stream through unchanged while the breaker watches them.

Iterations are counted on each `assistant` message (one per turn); its
content blocks are hashed for `loop-killer` detection. Tokens are read from
each assistant message's `usage` (input counts `input_tokens` plus cache
read/creation tokens). When a limit is hit the wrapper aborts the in-flight
query via the SDK's `abortController` option; any `abortController` you pass
in `options` is chained, so external cancellation still works.

With `onTrip`, the callback's return value is yielded as the generator's
final item instead of throwing.

## Vercel AI SDK

For the [AI SDK](https://ai-sdk.dev)'s `generateText` and its internal
tool-loop. Wrap the imported `generateText` and call the result exactly as you
would call `generateText` itself.

```ts
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/vercel-ai-sdk";

const guarded = withCircuitBreaker(generateText, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});

const result = await guarded({
  model: openai("gpt-4o"),
  prompt: "Analyze this repo",
  tools: { /* … */ },
  stopWhen: stepCountIs(20),
});
```

The wrapper takes `generateText` and returns a function with the same options
and result type. Iterations are counted on each finished step (one per LLM
call) via an injected `onStepFinish`; tokens are read from each step's `usage`
as per-call deltas. For `loop-killer`, the step's tool calls (or its text, as a
fallback) are hashed — a stuck agent re-issues the same tool call each step.

On a trip an internal `AbortSignal` cancels the loop before the next LLM call;
any `abortSignal` you pass is chained, and a caller-supplied `onStepFinish`
still fires for every step. If the trip lands on the final step (nothing left
to abort), it is surfaced after `generateText` returns. Your `stopWhen`,
`tools`, `prepareStep`, and other options pass through untouched.

With `onTrip`, the callback's return value becomes the result instead of
throwing. Streaming (`streamText`) is not yet supported — use the core
`CircuitBreaker` directly if you need it.

## LangGraph Platform SDK

For graphs deployed to **LangGraph Platform** and driven through the remote
`@langchain/langgraph-sdk` client. (For an in-process `@langchain/langgraph`
graph, use the [LangChain adapter](#langchainjs) — a compiled graph is a
`Runnable` and propagates callbacks.)

```ts
import { Client } from "@langchain/langgraph-sdk";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
const runs = withCircuitBreaker(client.runs, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});

for await (const chunk of runs.stream(threadId, "agent", {
  input: { messages: [{ role: "user", content: "Analyze this repo" }] },
  streamMode: "updates",
})) {
  // chunks stream through untouched
}
```

The wrapper takes `client.runs` and returns an object with the same
`stream(threadId, assistantId, payload)` signature.

Because the graph executes server-side, the breaker is driven off the
`events` stream mode — the only mode that reports both per-LLM-call
boundaries and token usage. The wrapper **forces `events` into the run's
`streamMode`**; if you didn't request it, those injected chunks are consumed
internally and never yielded, so your stream is unchanged. Iterations are
counted on each `on_chat_model_start`; tokens are read from each
`on_chat_model_end`'s `usage_metadata`. For `loop-killer`, the latest input
message is hashed.

On a trip the wrapper aborts the local stream **and** calls
`client.runs.cancel(...)` to stop the run server-side (the run id is taken
from the `metadata` event) — closing the SSE connection alone would leave the
graph running. Any `signal` you pass in the payload is chained, so external
aborts still work.

With `onTrip`, the callback's return value is yielded as the generator's
final item instead of throwing.

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
| `maxInputToken`        | budget-guard | `int ≥ 1`   | `10_000`   | Max aggregate input tokens before trip (post-hoc).                            |
| `maxOutputToken`       | budget-guard | `int ≥ 1`   | `10_000`   | Max aggregate output tokens before trip (post-hoc).                           |
| `estimateInputTokens`  | budget-guard | `(input) => number \| undefined` | — | Preflight estimator; trips before the call when the estimate exceeds `maxInputToken`. |
| `maxRetries`           | loop-killer  | `int ≥ 1`   | `3`        | Max times the same state may recur (or, with detection off, raw iterations). |
| `detectRepeatedState`  | loop-killer  | `boolean`   | `true`     | Hash each step's state for loop detection.                                   |
| `onEvent`              | both         | `EventListener` | —      | Receives `CircuitBreakerEvent` updates.                                      |
| `onTrip`               | wrappers     | `OnTrip<R>` | —          | Suppress the throw and use the callback's return value instead.              |

All numeric options are validated at construction; passing `0`, a negative,
`NaN`, `Infinity`, or a non-integer throws a `TypeError`.

## Contributing

#### 🤝 Our Philosophy & How You Can Help

We built Circuit Breaker to solve the immediate, visceral pain of runaway agent costs and infinite loops. However, we know that every execution environment is unique, and **we do not have all the answers.** 

Right now, we are intentionally keeping the API minimal with core modes like `budget-guard` and `loop-killer`. We believe that the best systems are discovered through real user friction, not designed in a vacuum. Because of this, our roadmap is entirely driven by how you use — or fight — this tool in the wild.

**We actively want to hear from you, especially if:**
* **It *almost* fits:** Our default modes are 80% right for you, but you need one specific tweak or condition to make it perfect.
* **You are building workarounds:** You find yourself writing custom scripts or wrapping our API to force it to do what you need.
* **You have diverging use cases:** Your industry requires vastly different behavior (e.g., ultra-strict trading apps vs. loose research agents) and our defaults are breaking.

When you stop asking *"what does this do?"* and start asking *"can I change how it works?"*, that is our signal to unlock more programmable control for the community. 

Please open an issue, share your GitHub gists, or reach out to us directly. Your edge cases are our roadmap! 

See [`AGENTS.md`](./AGENTS.md) for the project layout, build/test commands, and the recipe for adding a new framework adapter.


## License

Apache-2.0 — © 2026 MonetiseBG
