# API Reference

## `withCircuitBreaker(target, options)`

Available from every adapter subpath. Returns a wrapped version of `target` with the same call signature.

```ts
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/<adapter>";
```

---

## Options

| Field | Applies to mode | Type | Default | Description |
|---|---|---|---|---|
| `mode` | both | `"budget-guard" \| "loop-killer"` | `"budget-guard"` | Which protection mode to enable. |
| `maxInputToken` | budget-guard | `integer ≥ 1` | `10_000` | Maximum cumulative input tokens before the breaker trips (post-hoc). |
| `maxOutputToken` | budget-guard | `integer ≥ 1` | `10_000` | Maximum cumulative output tokens before the breaker trips (post-hoc). |
| `estimateInputTokens` | budget-guard | `(input) => number \| undefined` | — | Optional preflight estimator. If the estimate exceeds `maxInputToken`, the breaker throws before the underlying call is made. Return `undefined` to skip the check for a given invocation. |
| `maxRetries` | loop-killer | `integer ≥ 1` | `3` | Maximum times a state may recur (with `detectRepeatedState: true`) or the maximum raw iteration count (with `detectRepeatedState: false`). |
| `detectRepeatedState` | loop-killer | `boolean` | `true` | Hash each step's state and trip on repetition. Set to `false` for a plain iteration cap. |
| `onEvent` | both | `(event: CircuitBreakerEvent) => void` | — | Called on every `retry` and `stop` event. Errors thrown here are swallowed. |
| `onTrip` | both (wrappers only) | `(ctx: TripContext) => R` | — | Suppress the throw and use the return value as the run result instead. Typing is adapter-specific. |
| `silent` | both | `boolean` | `false` | Suppress the default `console.warn` log when the breaker trips. |
| `logger` | both | `(msg: string, ctx: TripContext) => void` | — | Custom log handler. Replaces the default `console.warn`. |

All numeric options are validated at construction: passing `0`, a negative number, `NaN`, `Infinity`, or a non-integer throws a `TypeError`.

---

## `CircuitBreakerError`

Thrown (or passed to `onTrip`) when a limit is reached.

```ts
import { CircuitBreakerError } from "@monetisebg/circuit-breaker";

try {
  await safeAgent.run("...");
} catch (err) {
  if (err instanceof CircuitBreakerError) {
    console.log(err.reason);   // StopReason
    console.log(err.metrics);  // { iterations, retries, tokens: { input, output } }
    console.log(err.limits);   // ResolvedLimits
  }
}
```

### Properties

| Property | Type | Description |
|---|---|---|
| `reason` | `StopReason` | Why the breaker tripped. |
| `metrics` | `Metrics` | Final usage snapshot at the time of the trip. |
| `limits` | `ResolvedLimits` | The effective limits that were in force (filled-in defaults). |
| `saved` | `number` | Signed `limit - usage`. Positive: headroom remaining. Negative: the final call exceeded the limit by this amount. |
| `message` | `string` | Human-readable description, also printed to the log. |

---

## `StopReason`

```ts
type StopReason =
  | "max_input_tokens"   // cumulative input tokens exceeded maxInputToken
  | "max_output_tokens"  // cumulative output tokens exceeded maxOutputToken
  | "max_retries"        // iteration cap exceeded (detectRepeatedState: false)
  | "repeated_state";    // same state hash recurred too many times (detectRepeatedState: true)
```

---

## `CircuitBreakerEvent`

```ts
type CircuitBreakerEvent =
  | { type: "retry"; retries: number }
  | { type: "stop"; reason: StopReason; saved: number };
```

---

## `TripContext`

Passed to `onTrip` and available on `CircuitBreakerError`:

```ts
interface TripContext {
  reason: StopReason;
  mode: "budget-guard" | "loop-killer";
  metrics: {
    iterations: number;
    retries: number;
    tokens: { input: number; output: number };
  };
  limits: ResolvedLimits;
  saved: number;
  message: string;
}
```

---

## `Metrics`

```ts
interface Metrics {
  iterations: number;  // total LLM calls / agent turns in this run
  retries: number;     // total repeated-state recurrences
  tokens: {
    input: number;     // cumulative input tokens
    output: number;    // cumulative output tokens
  };
}
```

---

## Core `CircuitBreaker` class

For building custom adapters. Exported from the package root.

```ts
import { CircuitBreaker } from "@monetisebg/circuit-breaker";

const breaker = new CircuitBreaker(options);

// Call at the start of each LLM call / agent step:
breaker.recordIteration(stateKey?);   // stateKey: string hash of the step's input

// Call after per-call token deltas are available:
breaker.addTokens(inputDelta, outputDelta);

// Call when the framework exposes running totals instead of deltas:
breaker.setTokenSnapshot(totalInput, totalOutput);
```

`recordIteration` and `addTokens`/`setTokenSnapshot` throw `CircuitBreakerError` when a limit is crossed. See [Building your own adapter](./06-advanced.md#building-your-own-adapter) for the full recipe.
