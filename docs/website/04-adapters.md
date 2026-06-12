# Adapters

Each adapter exposes one function: `withCircuitBreaker`. Pass in the framework-specific agent/runnable/function and your options; get back a drop-in replacement with the same call signature.

---

## LangChain.js

**Import:** `@monetisebg/circuit-breaker/langchain`  
**Peer dep:** `@langchain/core@^1.1.47`

Wraps any LangChain `Runnable` — most commonly an `AgentExecutor` — via a `BaseCallbackHandler`. The wrapper's `invoke` method has the same signature as the underlying runnable's `invoke`.

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

const result = await safeExecutor.invoke({ input: "Summarize this document" });
```

**How it works internally:**
- Iterations counted on `handleLLMStart` / `handleChatModelStart` (one per LLM call).
- Token usage read from `handleLLMEnd` with provider-agnostic extraction: supports OpenAI `tokenUsage`, Anthropic `usage`, and `usage_metadata`.
- Trip is surfaced by throwing `CircuitBreakerError` from inside the callback — LangChain propagates callback exceptions back to the caller.

**In-process LangGraph graphs:** a compiled `@langchain/langgraph` graph is a `Runnable`. Use this adapter (not the LangGraph Platform adapter) for in-process graphs.

---

## OpenAI Agents SDK

**Import:** `@monetisebg/circuit-breaker/openai-agents`  
**Peer dep:** `@openai/agents@^0.11.0`

Wraps an `Agent` instance. The returned `safeAgent` has the same `.run(input, options?)` method as a plain `Agent`.

```ts
import { Agent } from "@openai/agents";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/openai-agents";

const agent = new Agent({
  name: "Researcher",
  instructions: "You are a research assistant.",
  tools,
});

const safeAgent = withCircuitBreaker(agent, {
  mode: "loop-killer",
  maxRetries: 3,
});

const result = await safeAgent.run("Investigate recent AI safety papers");
```

**How it works internally:**
- Iterations counted on each `agent_start` event (one per turn).
- Token usage read live from `RunContext.usage` on each turn boundary (running total — the adapter uses `setTokenSnapshot` internally).
- The latest `turnInput` item is hashed for `loop-killer` state detection.
- Trip is enforced via `AbortSignal`; the runner's in-flight call is cancelled. Any `signal` you pass in options is chained, so your own cancellation still works.

> **Note:** Streaming (`stream: true`) is not yet supported.

---

## Claude Agent SDK

**Import:** `@monetisebg/circuit-breaker/claude-agent-sdk`  
**Peer dep:** `@anthropic-ai/claude-agent-sdk@^0.2`

Wraps the SDK's `query` function and returns a drop-in replacement with the same call signature. Both are async generators that yield `SDKMessage` items.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/claude-agent-sdk";

const safeQuery = withCircuitBreaker(query, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});

for await (const message of safeQuery({ prompt: "Refactor this codebase" })) {
  console.log(message);
}
```

**With `onTrip`:** the callback's return value is yielded as the generator's final item instead of throwing. This lets callers that consume the stream with `for await` receive a graceful final message.

```ts
const safeQuery = withCircuitBreaker(query, {
  maxOutputToken: 20_000,
  onTrip: (ctx) => ({
    type: "system",
    content: `Stopped: ${ctx.reason}. Tokens used: ${ctx.metrics.tokens.output}`,
  }),
});
```

**How it works internally:**
- Iterations counted on each `assistant` message (one per turn).
- Content blocks of each assistant message are hashed for `loop-killer` state detection.
- Tokens read from each assistant message's `usage` (`input_tokens` plus cache read/write tokens for input; `output_tokens` for output).
- Trip is enforced by aborting the in-flight query via the SDK's `abortController` option; any `abortController` you pass in options is chained.

---

## Vercel AI SDK

**Import:** `@monetisebg/circuit-breaker/vercel-ai-sdk`  
**Peer dep:** `ai@^5`

Wraps the `generateText` function from the AI SDK. The returned function has the same options and result type as the original `generateText`.

```ts
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/vercel-ai-sdk";

const safeGenerate = withCircuitBreaker(generateText, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});

const result = await safeGenerate({
  model: openai("gpt-4o"),
  prompt: "Analyze this repository",
  tools: { /* ... */ },
  stopWhen: stepCountIs(20),
});
```

**Pass-through behaviour:** your `stopWhen`, `tools`, `prepareStep`, `abortSignal`, and all other `generateText` options pass through untouched. A caller-supplied `onStepFinish` still fires for every step.

**How it works internally:**
- Iterations counted on each finished step (one per LLM call) via an injected `onStepFinish`.
- Token usage read from each step's `usage` as per-call deltas.
- For `loop-killer`, the step's tool calls are hashed (or the step's text, as a fallback) — a stuck agent typically re-issues the same tool call each step.
- Trip enforced by an internal `AbortSignal` that cancels the loop before the next LLM call; if the trip lands on the final step the error is surfaced after `generateText` returns.

> **Note:** `streamText` is not yet supported. Use the core `CircuitBreaker` directly if you need streaming.

---

## LangGraph Platform SDK

**Import:** `@monetisebg/circuit-breaker/langgraph-sdk`  
**Peer dep:** `@langchain/langgraph-sdk@^1`

For graphs deployed to **LangGraph Platform** and driven through the remote `@langchain/langgraph-sdk` client. Wraps `client.runs` and returns an object with the same `stream(threadId, assistantId, payload)` method.

```ts
import { Client } from "@langchain/langgraph-sdk";
import { withCircuitBreaker } from "@monetisebg/circuit-breaker/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
const safeRuns = withCircuitBreaker(client.runs, {
  maxInputToken: 50_000,
  maxOutputToken: 20_000,
});

for await (const chunk of safeRuns.stream(threadId, "agent", {
  input: { messages: [{ role: "user", content: "Analyze this dataset" }] },
  streamMode: "updates",
})) {
  console.log(chunk);
}
```

**Important:** because the graph executes server-side, the breaker must observe it remotely. The wrapper forces `events` into `streamMode` — the only mode that reports both per-LLM-call boundaries and token usage. If you didn't request `events`, the injected `events` chunks are consumed internally and never yielded; your stream remains unchanged.

**How it works internally:**
- Iterations counted on each `on_chat_model_start` event.
- Tokens read from each `on_chat_model_end`'s `usage_metadata`.
- For `loop-killer`, the latest input message is hashed.
- On a trip, the wrapper aborts the local stream **and** calls `client.runs.cancel(...)` to stop the run server-side (the run ID is taken from the `metadata` event). Closing the SSE connection alone would leave the graph running.
- Any `signal` you pass in the payload is chained.

**With `onTrip`:** the callback's return value is yielded as the generator's final item instead of throwing.
