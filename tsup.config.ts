import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    langchain: "src/langchain/index.ts",
    "openai-agents": "src/openai-agents/index.ts",
    "claude-agent-sdk": "src/claude-agent-sdk/index.ts",
    "langgraph-sdk": "src/langgraph-sdk/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  treeshake: true,
  splitting: false,
});
