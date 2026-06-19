# @monetisebg/circuit-breaker

[![CI](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@monetisebg/circuit-breaker.svg)](https://www.npmjs.com/package/@monetisebg/circuit-breaker)

> One wrapper between you and runaway execution.

Minimal **circuit breaker** for AI agents. Wrap any supported agent and pick a
mode — the breaker cuts the run short once provider-reported usage crosses a
limit, and (optionally) refuses an oversized prompt before it is even sent.

- Zero-config: defaults work out of the box.
- Two wrapper modes, pick one: **`budget-guard`** (token caps) and
  **`loop-killer`** (state-repeat detection).
- Plus **`worth-it`** — a predictive, cost-aware engine that projects the total
  spend of a run against a budget and gates it with graduated thresholds
  (warn → optimize → checkpoint). See [Worth-it mode](#worth-it-mode--predictive-cost-gates).
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
| `{ type: "stop"; reason: StopReason; saved: number }` | The breaker tripped                               | budget-guard, loop-killer |
| `{ type: "predictive_warning"; state: WorthItStepState }` | Projected cost crossed `0.70 · budgetLimit`   | worth-it     |
| `{ type: "optimize_context"; state: WorthItStepState }`   | Projected cost crossed `0.85 · budgetLimit`   | worth-it     |
| `{ type: "tripped"; reason: "budget_projection"; state: WorthItStepState }` | Projected cost crossed `0.95 · budgetLimit` (also throws) | worth-it |

`saved` is signed `limit - usage`: positive means headroom that won't be
spent, negative means the call that pushed us over the limit still counted.

`StopReason` is one of `"max_input_tokens" | "max_output_tokens" |
"max_retries" | "repeated_state" | "budget_projection"`.

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

## Worth-it mode — predictive cost gates

`worth-it` is the third `withCircuitBreaker` mode. Instead of capping token
counts post-hoc, it works in **currency**: it costs each step, smooths the
trend, and projects the **total** spend of the run so it can intervene *before*
the budget is gone. Pick it the same way you pick the other modes — set
`mode: "worth-it"` and pass its inputs — and the wrapper drives an internal
cost engine for you.

Because progress is developer-defined (the engine never asks the LLM to
estimate its own remaining work), you advance milestones from the
`onWorthItStep` hook, which fires once per finished step before that step is
costed:

```ts
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/vercel-ai-sdk";

const guarded = withCircuitBreaker(generateText, {
  mode: "worth-it",
  currency: "USD",                        // ISO 4217; amounts below are in cents
  budgetLimit: 500,                       // B_limit = $5.00, in cents (smallest unit)
  alpha: 0.3,                             // EMA smoothing (default 0.3)
  milestones: ["plan", "fetch", "synthesise", "write"], // M — array or a count
  // prices are quoted per 1M tokens, in cents (e.g. $3.00/1M in → 300):
  defaultPricing: { inputPerMToken: 300, outputPerMToken: 1500 },
  pricing: { "gpt-4o-mini": { inputPerMToken: 15, outputPerMToken: 60 } },
  onEvent(event) {
    if (event.type === "optimize_context") compactHistory();
  },
  // advance progress from each finished step → tighter projection
  onWorthItStep(controls, step) {
    if (stepReachedMilestone(step)) controls.completeMilestone();
  },
});

// throws CircuitBreakerError (reason "budget_projection") once the projected
// total would blow the budget — or routes through onTrip if you provide one.
const result = await guarded({
  model: openai("gpt-4o"),
  prompt: "Research and summarise…",
  stopWhen: stepCountIs(20),
});
```

`worth-it` is available on **all adapters**. The wrapper extracts each step's
token usage (and, where the framework exposes it, the model id for `pricing`
lookup) and feeds the engine; `onWorthItStep` receives that adapter's native
finished-step object (a Vercel `StepResult`, a Claude `SDKAssistantMessage`,
a LangChain `LLMResult`, etc.).

### Driving the engine directly

If you're on a framework without an adapter — or want full control — use the
engine from the `/worth-it` subpath and drive it from your own loop:

```ts
import { WorthItEngine } from "@monetisebg/circuit-breaker/worth-it";

const engine = new WorthItEngine({
  currency: "USD",                        // default "USD"; amounts in cents
  budgetLimit: 500,                       // $5.00
  milestones: ["plan", "fetch", "synthesise", "write"],
  defaultPricing: { inputPerMToken: 300, outputPerMToken: 1500 }, // per 1M tokens, cents
});

for (const task of plan) {
  const result = await runStep(task);
  // throws CircuitBreakerError once the projected total would blow the budget
  engine.recordStep({
    input: result.usage.inputTokens,
    output: result.usage.outputTokens,
    model: result.model,                  // looked up in `pricing`, else default
  });
  engine.completeMilestone();             // advance progress → tighter projection
}
```

The core `CircuitBreaker` class is the single entry point for all three modes,
so `new CircuitBreaker({ mode: "worth-it", … })` works too — it delegates to a
`WorthItEngine` internally and exposes the same `recordStep` /
`completeMilestone` / `setCompletedMilestones` methods (plus `worthItMetrics`).
`WorthItEngine` is just the standalone form for when you don't need the rest of
the breaker surface.

### How the projection works

At each step `s` the engine computes:

- **Step cost** `C_s = (I_s·P_in + O_s·P_out) / 1e6` (cache read/write tokens
  priced too). Prices are **per 1M tokens**, in the currency's smallest unit.
- **Smoothed average** `EMA_s = α·C_s + (1−α)·EMA_(s−1)` (`EMA_1 = C_1`).
- **Remaining cost** `ERC_s = EMA_s · R_s`, where `R_s = N_total − N_completed`.
- **Projected total** `C_proj = C_cum + ERC_s`.

`C_proj` is checked against three thresholds (fractions of `budgetLimit`):

| Projection                        | Action          | What happens                                                            |
| --------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `C_proj > 0.70 · budgetLimit`     | **Warn**        | Emits `predictive_warning`. No interruption.                          |
| `C_proj > 0.85 · budgetLimit`     | **Optimize**    | Emits `optimize_context` — compact history / swap to a cheaper model. |
| `C_proj > 0.95 · budgetLimit`     | **Checkpoint**  | Emits `tripped` and throws `CircuitBreakerError`.                     |

Each advisory event fires **once**, when its threshold is first crossed.
The ratios are overridable (`warnRatio` / `optimizeRatio` / `tripRatio`).

A trip is a **checkpoint & pause**, not a permanent kill: the engine isn't
latched, so after you compact context or advance milestones, the next
`recordStep` re-evaluates the projection and can clear the critical state.

### Progress & earned-value metrics

Progress is driven entirely by milestones you mark complete
(`completeMilestone(n?)` / `setCompletedMilestones(n)`). `engine.metrics`
exposes the full per-step snapshot, including `progress` (`N_completed/N_total`)
and the **budget burn rate** `BBR = (C_cum/budgetLimit) / progress`:

- `BBR ≈ 1.0` — spend tracks progress.
- `BBR > 1.2` — overrun trend: burning tokens faster than hitting milestones.
- `BBR < 1.0` — ahead of budget. (`BBR` is `0` when progress is `0` — no `NaN`.)

The thrown `CircuitBreakerError` carries the serialized step state on
`error.worthIt` (and the `tripped` event carries the same on `event.state`):
`projectedCost`, `cumulativeCost`, `estimatedRemainingCost`, `ema`,
`remainingSteps`, `progress`, `burnRate`, and the milestone counts.

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
| `mode`                 | all          | `Mode`      | `"budget-guard"` | `"budget-guard"`, `"loop-killer"`, or `"worth-it"`.                  |
| `maxInputToken`        | budget-guard | `int ≥ 1`   | `10_000`   | Max aggregate input tokens before trip (post-hoc).                            |
| `maxOutputToken`       | budget-guard | `int ≥ 1`   | `10_000`   | Max aggregate output tokens before trip (post-hoc).                           |
| `estimateInputTokens`  | budget-guard | `(input) => number \| undefined` | — | Preflight estimator; trips before the call when the estimate exceeds `maxInputToken`. |
| `maxRetries`           | loop-killer  | `int ≥ 1`   | `3`        | Max times the same state may recur (or, with detection off, raw iterations). |
| `detectRepeatedState`  | loop-killer  | `boolean`   | `true`     | Hash each step's state for loop detection.                                   |
| `onEvent`              | all          | `EventListener` | —      | Receives `CircuitBreakerEvent` updates.                                      |
| `onTrip`               | wrappers     | `OnTrip<R>` | —          | Suppress the throw and use the callback's return value instead.              |
| `onWorthItStep`        | worth-it     | `(controls, step) => void` | — | Per-step hook to advance milestones; receives the adapter's finished-step object. |

All numeric options are validated at construction; passing `0`, a negative,
`NaN`, `Infinity`, or a non-integer throws a `TypeError`.

### `worth-it` options

These are the inputs for `mode: "worth-it"` (whether through `withCircuitBreaker`
or directly on `WorthItEngine`):

| Field             | Type                              | Default | Description                                                        |
| ----------------- | --------------------------------- | ------- | ----------------------------------------------------------------- |
| `budgetLimit`     | `number > 0`                      | —       | **Required.** `B_limit` — the run's budget ceiling, in `currency`'s smallest unit (e.g. cents). |
| `currency`        | `string` (ISO 4217)               | `"USD"` | Currency all amounts (budget + prices) are expressed in. Informational; used for log formatting. |
| `milestones`      | `string[]` (non-empty) or `int ≥ 1` | —     | **Required.** Planned milestones; `N_total` is their count.       |
| `alpha`           | `number` in `(0, 1]`              | `0.3`   | EMA smoothing factor `α`.                                          |
| `pricing`         | `Record<string, ModelPricing>`    | `{}`    | Per-model price table, keyed by model id.                         |
| `defaultPricing`  | `ModelPricing`                    | —       | Fallback when a step's `model` isn't in `pricing`.               |
| `warnRatio`       | `number` in `(0, 1]`              | `0.70`  | Warn threshold as a fraction of `budgetLimit`.                    |
| `optimizeRatio`   | `number` in `(0, 1]`              | `0.85`  | Optimize threshold.                                               |
| `tripRatio`       | `number` in `(0, 1]`              | `0.95`  | Checkpoint/trip threshold.                                        |
| `onEvent`         | `EventListener`                   | —       | Receives `predictive_warning` / `optimize_context` / `tripped`.  |
| `silent`/`logger` | `boolean` / `Logger`             | —       | Same trip-logging controls as the wrapper modes.                 |

`ModelPricing` is `{ inputPerMToken, outputPerMToken, cacheReadPerMToken?,
cacheWritePerMToken? }` — each a price **per 1,000,000 tokens** in the currency's
smallest unit (e.g. cents). A model billed at $3.00 / 1M input tokens is
`inputPerMToken: 300`. Cache rates default to `inputPerMToken`.

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
