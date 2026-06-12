# Core Concepts

## How it works

Circuit Breaker wraps your agent or runnable and injects a thin observation layer — a callback handler, an event listener, or a generator proxy, depending on the framework. It watches two dimensions of agent behaviour:

1. **Token usage** — cumulative input and output tokens across all LLM calls in a single run.
2. **State repetition** — a hash of each step's input (the latest message or turn) used to detect loops.

When either dimension crosses its limit, the breaker trips: it aborts the in-flight run via the appropriate mechanism (`AbortSignal`, exception from a callback, or a generator `return`) and surfaces a `CircuitBreakerError` to your caller — or calls your `onTrip` handler instead.

A fresh `CircuitBreaker` instance is created for every `invoke` / `run` / `query` call. Wrappers are safe to reuse and to call concurrently.

---

## Modes

### `budget-guard` (default)

Caps cumulative **input tokens** and **output tokens** independently.

```ts
withCircuitBreaker(agent, {
  mode: "budget-guard",    // this is the default, can be omitted
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});
```

Token counts are read from the provider's response after each LLM call completes. The call that pushes a bucket over its limit still counts — the breaker trips **before** the next call. To reject an oversized first prompt before any provider work happens, add a preflight estimator (see [Advanced: Preflight estimation](./06-advanced.md#preflight-estimation)).

Token usage is tracked in `loop-killer` mode too — it just doesn't trip on it.

**Defaults:** `maxInputToken: 10_000`, `maxOutputToken: 10_000`

---

### `loop-killer`

Detects **state repetition** across agent steps.

```ts
withCircuitBreaker(agent, {
  mode: "loop-killer",
  maxRetries: 3,             // default — trips when the same state recurs more than 3 times
  detectRepeatedState: true, // default
});
```

With `detectRepeatedState: true` (default), the breaker hashes each step's state (the latest message or turn input) and trips when any single state hash recurs more than `maxRetries` times. This catches agents that are genuinely stuck issuing the same input over and over.

With `detectRepeatedState: false`, it falls back to a raw iteration cap — the breaker trips after more than `maxRetries` total iterations regardless of state.

**When to use `loop-killer`:** agents with tools, multi-step workflows, or any scenario where the agent might call the same tool with the same arguments in a spiral. `budget-guard` still catches runaways that vary their output slightly on each loop; `loop-killer` is the right choice when token budget is not the binding constraint.

---

## The trip boundary

Both modes enforce limits **post-hoc by default**: the call or step that pushes usage over the limit completes normally, and the breaker trips before the *next* call. This means:

- Your `onTrip` handler / catch block receives accurate final usage metrics, including the over-limit call.
- `saved` in the trip context is signed: positive means headroom left, negative means the overage (how far the limit was exceeded by the final call).

To enforce limits *before* the first call, use [preflight estimation](./06-advanced.md#preflight-estimation).

---

## Events

The breaker emits `CircuitBreakerEvent`s as the run progresses, regardless of mode:

| Event shape | When emitted |
|---|---|
| `{ type: "retry"; retries: number }` | A state hash recurred (`detectRepeatedState: true`), or each iteration past the first (`detectRepeatedState: false`) |
| `{ type: "stop"; reason: StopReason; saved: number }` | The breaker tripped |

`StopReason` values: `"max_input_tokens"` · `"max_output_tokens"` · `"max_retries"` · `"repeated_state"`

Subscribe with `onEvent`:

```ts
withCircuitBreaker(agent, {
  onEvent(event) {
    console.log("[circuit-breaker]", event);
  },
});
```

Errors thrown inside `onEvent` are swallowed — a buggy listener never breaks the agent run.
