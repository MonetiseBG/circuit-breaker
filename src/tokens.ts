import type { LLMResult } from "@langchain/core/outputs";

export interface ExtractedTokens {
  input: number;
  output: number;
}

/**
 * Pull input/output token counts out of an LLMResult. Different providers
 * expose usage in different shapes; we check the common ones and fall back to
 * zero if nothing is recognised (the breaker simply won't fire on tokens for
 * that provider — iteration limits still work).
 */
export function extractTokens(result: LLMResult): ExtractedTokens {
  const llmOutput = (result.llmOutput ?? {}) as Record<string, unknown>;

  // OpenAI-style: { tokenUsage: { promptTokens, completionTokens, totalTokens } }
  const tokenUsage = llmOutput["tokenUsage"] as
    | { promptTokens?: number; completionTokens?: number }
    | undefined;
  if (tokenUsage) {
    return {
      input: tokenUsage.promptTokens ?? 0,
      output: tokenUsage.completionTokens ?? 0,
    };
  }

  // Anthropic / generic snake_case: { usage: { input_tokens, output_tokens } }
  const usage = llmOutput["usage"] as
    | {
        input_tokens?: number;
        output_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
      }
    | undefined;
  if (usage) {
    return {
      input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      output: usage.output_tokens ?? usage.completion_tokens ?? 0,
    };
  }

  // Fallback: usage_metadata on the generated message (newer LangChain shape).
  const firstBatch = result.generations?.[0];
  if (firstBatch) {
    for (const gen of firstBatch) {
      const message = (gen as { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } }).message;
      const meta = message?.usage_metadata;
      if (meta) {
        return {
          input: meta.input_tokens ?? 0,
          output: meta.output_tokens ?? 0,
        };
      }
    }
  }

  return { input: 0, output: 0 };
}
