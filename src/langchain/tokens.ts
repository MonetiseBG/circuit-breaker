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
 *
 * Each candidate shape is validated through {@link numberField} so a
 * malformed payload (e.g. `prompt_tokens: "10"`) returns zero rather than
 * corrupting breaker metrics.
 */
export function extractTokens(result: LLMResult): ExtractedTokens {
  const llmOutput = isRecord(result.llmOutput) ? result.llmOutput : {};

  // OpenAI-style: { tokenUsage: { promptTokens, completionTokens } }
  const tokenUsage = llmOutput["tokenUsage"];
  if (isRecord(tokenUsage)) {
    return {
      input: numberField(tokenUsage, "promptTokens") ?? 0,
      output: numberField(tokenUsage, "completionTokens") ?? 0,
    };
  }

  // Anthropic / generic snake_case: { usage: { input_tokens, output_tokens } }
  const usage = llmOutput["usage"];
  if (isRecord(usage)) {
    return {
      input:
        numberField(usage, "input_tokens") ??
        numberField(usage, "prompt_tokens") ??
        0,
      output:
        numberField(usage, "output_tokens") ??
        numberField(usage, "completion_tokens") ??
        0,
    };
  }

  // Fallback: usage_metadata on the generated message (newer LangChain shape).
  const firstBatch = result.generations?.[0];
  if (firstBatch) {
    for (const gen of firstBatch) {
      if (!isRecord(gen)) continue;
      const message = gen["message"];
      if (!isRecord(message)) continue;
      const meta = message["usage_metadata"];
      if (!isRecord(meta)) continue;
      return {
        input: numberField(meta, "input_tokens") ?? 0,
        output: numberField(meta, "output_tokens") ?? 0,
      };
    }
  }

  return { input: 0, output: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
