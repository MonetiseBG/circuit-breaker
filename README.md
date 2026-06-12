# @monetisebg/circuit-breaker

[![CI](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/MonetiseBG/circuit-breaker/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@monetisebg/circuit-breaker.svg)](https://www.npmjs.com/package/@monetisebg/circuit-breaker)

> One wrapper between you and runaway execution.

Minimal circuit breaker for AI agents. Wrap any supported agent, pick a mode, and it will cut the run short before a token spiral or infinite loop becomes your problem.

**Full documentation → [circuitbreaker.dev](https://circuitbreaker.dev)**

[Watch the 1-minute overview](https://www.youtube.com/watch?v=nhRmZBkjeFU)

[![Circuit Breaker — 1-min explainer](https://img.youtube.com/vi/nhRmZBkjeFU/1.jpg)](https://www.youtube.com/watch?v=nhRmZBkjeFU)

## Install

Requires **Node ≥ 22**.

```bash
npm install @monetisebg/circuit-breaker
# plus the peer dep for your framework:
npm install @langchain/core@^1.1.47              # LangChain adapter
npm install @openai/agents@^0.11.0               # OpenAI Agents adapter
npm install @anthropic-ai/claude-agent-sdk@^0.2  # Claude Agent SDK adapter
npm install ai@^5                                 # Vercel AI SDK adapter
npm install @langchain/langgraph-sdk@^1           # LangGraph Platform adapter
```

## Quick start

```ts
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/openai-agents";

// budget-guard (default): caps input + output tokens independently
const safeAgent = withCircuitBreaker(agent, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});

await safeAgent.run("Analyze this dataset");
```

```ts
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/langchain";

// loop-killer: trips when the agent repeats the same state
const safeExecutor = withCircuitBreaker(executor, {
  mode: "loop-killer",
  maxRetries: 3,
});

await safeExecutor.invoke({ input: "..." });
```

When the breaker trips it throws `CircuitBreakerError` with `reason`, `metrics`, and `limits`. Pass `onTrip` to return a fallback value instead of throwing.

## Adapters

| Import | Framework |
|---|---|
| `@monetisebg/circuit-breaker/langchain` | LangChain.js |
| `@monetisebg/circuit-breaker/openai-agents` | OpenAI Agents SDK |
| `@monetisebg/circuit-breaker/claude-agent-sdk` | Claude Agent SDK |
| `@monetisebg/circuit-breaker/vercel-ai-sdk` | Vercel AI SDK |
| `@monetisebg/circuit-breaker/langgraph-sdk` | LangGraph Platform SDK |

The package root exports the framework-agnostic `CircuitBreaker` core for building your own adapter.

## Contributing

See [`AGENTS.md`](./AGENTS.md) for the project layout, build/test commands, and the recipe for adding a new framework adapter.

## License

Apache-2.0 — © 2026 MonetiseBG
