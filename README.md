# @monetisebg/circuit-breaker

[![CI](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@monetisebg/circuit-breaker.svg)](https://www.npmjs.com/package/@monetisebg/circuit-breaker)

> One wrapper between you and runaway execution.

An agent that loops forever, or quietly burns through your token budget on a
single bad run, is a production incident waiting to happen. You usually find
out from the bill, or from a thread that never returns.

**Circuit Breaker is the one wrapper that stops it.** Wrap any supported agent,
pick a mode, and the breaker cuts the run short the moment it crosses a limit —
before the loop spirals, before the budget is gone.

```ts
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/openai-agents";

const safeAgent = withCircuitBreaker(agent); // that's it — 10k/10k token caps by default

await safeAgent.run("Analyze this dataset");
```

No config to get started. No tokenizer to wire up. No lock-in to one framework.

📖 **Full documentation: [circuitbreaker.dev/docs](https://circuitbreaker.dev/docs)**

[Watch the 1-minute overview](https://www.youtube.com/watch?v=nhRmZBkjeFU) — see Circuit Breaker stop a runaway agent in real time.

[![Circuit Breaker — 1-min explainer](https://img.youtube.com/vi/nhRmZBkjeFU/1.jpg)](https://www.youtube.com/watch?v=nhRmZBkjeFU)

## Install

Requires **Node ≥ 22**.

```bash
npm install @monetisebg/circuit-breaker
# + the framework you already use (peer deps are optional — install only one):
npm install @langchain/core@^1.1.47              # LangChain.js
npm install @openai/agents@^0.11.0               # OpenAI Agents SDK
npm install @anthropic-ai/claude-agent-sdk@^0.2  # Claude Agent SDK
npm install ai@^5                                 # Vercel AI SDK
npm install @langchain/langgraph-sdk@^1           # LangGraph Platform SDK
```

## Pick a mode

One wrapper, three behaviours. Set `mode` and you're done.

| Mode | Stops a run when… | Reach for it when… |
| --- | --- | --- |
| **`budget-guard`** *(default)* | aggregate input/output tokens cross a cap | you want a hard ceiling on token spend |
| **`loop-killer`** | the same state recurs more than `maxRetries` times | agents get stuck re-trying the same step |
| **`worth-it`** | the *projected* total cost of the run would blow a budget | you think in money, and want to intervene **before** it's spent |

```ts
// budget-guard — token caps (the default)
withCircuitBreaker(agent, { maxInputToken: 50_000, maxOutputToken: 20_000 });

// loop-killer — kill stuck agents
withCircuitBreaker(agent, { mode: "loop-killer", maxRetries: 3 });

// worth-it — predictive, cost-aware budget gates
withCircuitBreaker(agent, {
  mode: "worth-it",
  budgetLimit: 500,                       // $5.00 in cents
  milestones: ["plan", "fetch", "write"],
  defaultPricing: { inputPerMToken: 300, outputPerMToken: 1500 },
});
```

`worth-it` is the advanced one: it costs each step, smooths the trend, and
projects the **total** spend of the run so it can warn, optimize, and finally
trip *before* the budget is gone — not after.
[Read the deep dive →](https://circuitbreaker.dev/docs/modes/worth-it)

## Works with your stack

Shipped adapters, each a drop-in wrapper around the framework you already use:

- **[LangChain.js](https://circuitbreaker.dev/docs/integrations/langchain)**
- **[OpenAI Agents SDK](https://circuitbreaker.dev/docs/integrations/openai-agents)**
- **[Claude Agent SDK](https://circuitbreaker.dev/docs/integrations/claude-agent-sdk)**
- **[Vercel AI SDK](https://circuitbreaker.dev/docs/integrations/vercel-ai-sdk)**
- **[LangGraph Platform SDK](https://circuitbreaker.dev/docs/integrations/langgraph-sdk)**

## Why developers reach for it

- **Zero-config defaults** — sensible caps work out of the box.
- **Visible** — emits `CircuitBreakerEvent`s as the run progresses; pipe them to your UI or observability stack.
- **Typed** — throws a typed `CircuitBreakerError`, or routes through your `onTrip` handler for a graceful fallback.
- **Lean** — optional peer deps, no bundled tokenizer. You install only what you use.

Full options, the projection math, responsible-usage guidance, and per-framework
guides live at **[circuitbreaker.dev/docs](https://circuitbreaker.dev/docs)**.

## Contributing

We built Circuit Breaker to solve the visceral pain of runaway agent costs and
infinite loops — but every execution environment is unique, and **we don't have
all the answers.** The API is intentionally minimal today; our roadmap is driven
by how you use (or fight) the tool in the wild.

We especially want to hear from you when:

- **It *almost* fits** — the defaults are 80% right but you need one tweak.
- **You're building workarounds** — wrapping our API to force a behaviour.
- **Your use case diverges** — strict trading apps vs. loose research agents.

Open an issue, share a gist, or reach out. Your edge cases are our roadmap.

See [`AGENTS.md`](./AGENTS.md) for project layout, build/test commands, and the
recipe for adding a new framework adapter.

## License

Apache-2.0 — © 2026 MonetiseBG
