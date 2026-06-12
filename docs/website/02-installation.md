# Installation

## Install the package

```bash
npm install @monetisebg/circuit-breaker
```

## Install your framework adapter

Circuit Breaker uses optional peer dependencies — install only the framework you actually use. Minimum versions are enforced.

```bash
# LangChain.js
npm install @langchain/core@^1.1.47

# OpenAI Agents SDK
npm install @openai/agents@^0.11.0

# Claude Agent SDK
npm install @anthropic-ai/claude-agent-sdk@^0.2

# Vercel AI SDK
npm install ai@^5

# LangGraph Platform SDK
npm install @langchain/langgraph-sdk@^1
```

You only need the peer dep for the adapter you import. Installing multiple adapters in one project is fine — they are independently bundled and do not share peer dependencies.

## TypeScript

No additional type packages are required. Circuit Breaker ships `.d.ts` declarations for every entry point. Your `tsconfig.json` must have `moduleResolution` set to `node16`, `nodenext`, or `bundler` (all subpath imports use the `exports` map).
