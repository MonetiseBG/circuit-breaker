# AGENTS.md

Guide for AI coding agents (and humans) working in this repository.

> This is the canonical instruction file. `CLAUDE.md` exists for Claude Code
> compatibility and defers to this document.

---

## What this package is

`@monetisebg/circuit-breaker` is an open-source npm package: a circuit breaker
for AI agents that stops execution after configurable **iteration** or
**token** limits. Decision logic lives in a framework-agnostic core; each
agent framework gets its own thin adapter exposed as a subpath import.

Current adapters:

- `@monetisebg/circuit-breaker/langchain` — wraps any LangChain `Runnable`
  (e.g. `AgentExecutor`) via a `BaseCallbackHandler`.
- `@monetisebg/circuit-breaker/openai-agents` — wraps an `Agent` from the
  OpenAI Agents SDK using `Runner` events and `AbortSignal`.

The package root (`@monetisebg/circuit-breaker`) exports only the core:
`CircuitBreaker`, `CircuitBreakerError`, and the option/context types.

---

## Repository layout

```
src/
├── core/                  # Framework-agnostic decision logic.
│   ├── breaker.ts         #   CircuitBreaker class — the single source of truth.
│   ├── errors.ts          #   CircuitBreakerError.
│   ├── logger.ts          #   defaultLogger (console.warn-based).
│   ├── types.ts           #   Public types (Options, Metrics, TripContext, …).
│   └── index.ts
├── langchain/             # LangChain.js adapter.
│   ├── callback.ts        #   CircuitBreakerCallback : BaseCallbackHandler.
│   ├── tokens.ts          #   Provider-shape-aware token extraction.
│   ├── wrapper.ts         #   withCircuitBreaker(runnable, options).
│   └── index.ts
├── openai-agents/         # @openai/agents adapter.
│   ├── wrapper.ts         #   withCircuitBreaker(agent, options) — uses
│   │                      #   Runner + AbortController + lifecycle events.
│   └── index.ts
└── index.ts               # Root: re-exports core only.

tests/
├── core/breaker.test.ts
├── langchain/{callback,wrapper}.test.ts
└── openai-agents/wrapper.test.ts
```

Build output goes to `dist/` with one ESM bundle, one CJS bundle, and one
`.d.ts` per entry (`index`, `langchain`, `openai-agents`).

---

## Commands

```bash
npm install              # install dev + peer deps locally
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run test:watch       # vitest in watch mode
npm run build            # tsup → dist/ (ESM + CJS + types, multi-entry)
```

`npm run prepublishOnly` chains typecheck + test + build and is the gate
before publishing.

---

## Engineering conventions

- **TypeScript everywhere**, strict mode. `noUncheckedIndexedAccess` is on —
  index access on arrays/records returns `T | undefined`; handle it.
- **No code comments unless they explain a non-obvious *why*.** Identifiers
  should explain *what*. Don't reference current tasks or PR numbers.
- **No backwards-compat shims.** We're pre-1.0; breaking changes are OK,
  prefer cleaner APIs.
- **Errors are typed.** `CircuitBreakerError` carries `reason`, `metrics`,
  `limits`. Don't throw generic `Error` when the breaker trips.
- **Peer deps are optional.** A user importing `/langchain` must not be
  forced to install `@openai/agents`, and vice versa. Subpath bundles must
  not cross-import — `src/openai-agents/` must never reach into
  `src/langchain/` and vice versa. Both may import from `src/core/`.
- **Tests don't hit the network.** Adapters are tested against fake
  framework objects (LangChain: a stub runnable that fires callbacks;
  OpenAI Agents: `vi.mock("@openai/agents", …)` with an EventEmitter-backed
  `FakeRunner`).
- **One breaker per invocation.** Adapters construct a fresh `CircuitBreaker`
  each time their entry method (`invoke` / `run`) is called. The wrappers
  must be safe to reuse and to call concurrently.

### Style choices baked into the codebase

- Iteration count is incremented at *call start* (LLM call / agent turn) so
  the breaker can refuse the `n+1`th call before it happens.
- Token tripping is checked *after each call completes* (the call that
  pushed us over still counts).
- Both `addTokens(delta, delta)` and `setTokenSnapshot(absIn, absOut)` exist
  on the core — adapters pick whichever matches the framework's data model.

---

## Adding a new framework adapter

The whole point of the core/adapter split. Recipe:

1. **Create `src/<framework>/`** with at least `wrapper.ts` and `index.ts`.
2. **Import the core**: `CircuitBreaker`, `CircuitBreakerError`, and the
   relevant types from `../core/index.js`. Do not duplicate decision logic.
3. **Map framework events onto core primitives**:
   - On each new LLM call / agent step → `breaker.recordIteration()`.
   - On per-call usage → `breaker.addTokens(input, output)`.
   - On a running total exposed by the framework →
     `breaker.setTokenSnapshot(totalIn, totalOut)`.
4. **Decide how to abort**. If the framework supports `AbortSignal`, use it
   (see `openai-agents/wrapper.ts`). If it propagates exceptions from
   callbacks, throw directly (see `langchain/callback.ts`). Either way, the
   public throw type must be `CircuitBreakerError`.
5. **Honour `onTrip`**: if provided, suppress the error and return whatever
   `onTrip(context)` returns. Type the wrapper so this becomes a union with
   the framework's normal return type.
6. **Add the entry to `tsup.config.ts`** and to the `exports` map in
   `package.json`. Add the framework as an *optional* peer dep with
   `peerDependenciesMeta.<name>.optional = true`.
7. **Write tests** under `tests/<framework>/` that don't require network
   access — mock or stub the framework's runtime.
8. **Update `README.md`** with a usage example.

If a framework only gives you post-hoc usage info (no mid-run hooks), token
limits won't be enforceable mid-run for it — document that explicitly.

---

## Release checklist

This repo isn't on a CI pipeline yet, so do it by hand:

1. Bump `version` in `package.json` (SemVer; we're 0.x so breaking changes
   are minor bumps).
2. `npm run prepublishOnly` — must pass cleanly.
3. Commit. Tag `v<version>`.
4. `npm publish --access public` (scoped packages require `--access public`
   on first publish).
5. Push tags: `git push --tags`.

---

## Branching

- `develop` — default working branch.
- Feature work on short-lived branches off `develop`, merged back via PR.
- `main` is reserved for release-tagged commits (not in use yet — `develop`
  is currently the only branch).
