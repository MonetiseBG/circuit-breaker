export interface ExtractedTokens {
  input: number;
  output: number;
}

/**
 * Pull input/output token counts out of the `data.output` payload of an
 * `on_chat_model_end` / `on_llm_end` streamed event (LangGraph Server `events`
 * stream mode). The output is usually a serialised `AIMessage` carrying the
 * provider-neutral `usage_metadata`, but older graphs stream an `LLMResult`
 * shape instead — we check both, plus raw provider `usage` blocks, and fall
 * back to zero if nothing is recognised (iteration limits still work).
 *
 * Each candidate is validated through {@link numberField} so a malformed
 * payload (e.g. `input_tokens: "10"`) returns zero rather than corrupting
 * breaker metrics.
 */
export function extractTokens(output: unknown): ExtractedTokens {
  // Newer LangChain shape: usage_metadata directly on the message.
  const direct = fromUsageMetadata(output);
  if (direct) return direct;

  // LLMResult shape: { generations: [[{ message: { usage_metadata } }]] }.
  if (isRecord(output)) {
    const generations = output["generations"];
    if (Array.isArray(generations)) {
      for (const batch of generations) {
        const list = Array.isArray(batch) ? batch : [batch];
        for (const gen of list) {
          if (!isRecord(gen)) continue;
          const fromMessage = fromUsageMetadata(gen["message"]);
          if (fromMessage) return fromMessage;
        }
      }
    }

    // OpenAI-style: { llmOutput: { tokenUsage: { promptTokens, completionTokens } } }
    const llmOutput = output["llmOutput"];
    if (isRecord(llmOutput)) {
      const tokenUsage = llmOutput["tokenUsage"];
      if (isRecord(tokenUsage)) {
        return {
          input: numberField(tokenUsage, "promptTokens") ?? 0,
          output: numberField(tokenUsage, "completionTokens") ?? 0,
        };
      }
    }

    // Raw provider usage block (Anthropic snake_case / OpenAI) on the message.
    const usage =
      output["usage"] ??
      (isRecord(output["response_metadata"])
        ? output["response_metadata"]["usage"]
        : undefined);
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
  }

  return { input: 0, output: 0 };
}

function fromUsageMetadata(node: unknown): ExtractedTokens | undefined {
  if (!isRecord(node)) return undefined;
  const meta = node["usage_metadata"];
  if (!isRecord(meta)) return undefined;
  return {
    input: numberField(meta, "input_tokens") ?? 0,
    output: numberField(meta, "output_tokens") ?? 0,
  };
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
