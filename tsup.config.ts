import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    langchain: "src/langchain/index.ts",
    "openai-agents": "src/openai-agents/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  treeshake: true,
  splitting: false,
});
