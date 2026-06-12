# Circuit Breaker

**One wrapper between you and runaway execution.**

Circuit Breaker is a minimal, framework-agnostic safety layer for AI agents. Wrap any supported agent and it will automatically cut the run short when token usage exceeds your budget, or when the agent gets stuck repeating itself — before either problem burns your API bill or hangs your application.

## Why Circuit Breaker?

AI agents are non-deterministic. A single malformed tool response, an ambiguous instruction, or an unexpected model behaviour can send an agent into an infinite loop or a token spiral. Circuit Breaker gives you a deterministic kill switch that sits outside the agent's own reasoning — it cannot be argued out of, hallucinated away, or overridden by the model.

- **Zero config to get started.** Defaults (10k input + 10k output tokens, max 3 loop retries) work out of the box for most use cases.
- **Two modes.** Pick the one that matches your risk: `budget-guard` for token cost control, `loop-killer` for repetition detection.
- **Post-hoc enforcement by default.** The call that pushes you over the limit still completes — the breaker trips before the *next* call. Use the optional preflight estimator to reject oversized inputs before any provider work happens.
- **Visible.** Emits `CircuitBreakerEvent`s so you can log, surface in your UI, or pipe to your observability stack.
- **Typed.** Throws `CircuitBreakerError` with structured context (`reason`, `metrics`, `limits`), or routes through your own `onTrip` handler if you prefer a fallback value over an exception.
- **Lean peer dependencies.** Only install the framework adapter you actually need; the others are never pulled in.
- **No bundled tokenizer.** Bring your own (`js-tiktoken`, `tiktoken`, your provider's SDK) — or skip preflight entirely and rely on post-hoc enforcement.

## Supported frameworks

| Adapter import path | Framework |
|---|---|
| `@monetisebg/circuit-breaker/langchain` | LangChain.js (`AgentExecutor`, any `Runnable`) |
| `@monetisebg/circuit-breaker/openai-agents` | OpenAI Agents SDK |
| `@monetisebg/circuit-breaker/claude-agent-sdk` | Claude Agent SDK |
| `@monetisebg/circuit-breaker/vercel-ai-sdk` | Vercel AI SDK (`generateText`) |
| `@monetisebg/circuit-breaker/langgraph-sdk` | LangGraph Platform SDK |

The package root (`@monetisebg/circuit-breaker`) also exports the framework-agnostic `CircuitBreaker` core for building your own adapter.

## Requirements

- **Node.js ≥ 22** (uses `node:crypto` for state hashing)
- TypeScript users: the package ships full type declarations; no `@types/*` needed
