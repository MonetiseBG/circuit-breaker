export interface ExtractedTokens {
  input: number;
  output: number;
}

/**
 * Pull input/output token counts out of a `StepResult.usage`
 * ({@link https://ai-sdk.dev | AI SDK} `LanguageModelUsage`). AI SDK v5/v6
 * normalise usage to `inputTokens` / `outputTokens`; v4 used
 * `promptTokens` / `completionTokens`. We read both and fall back to zero if
 * neither is present (iteration limits still work).
 *
 * `inputTokens` already accounts for cached prompt tokens on the providers the
 * SDK normalises, so the per-token cache details are not added on top.
 */
export function extractTokens(usage: unknown): ExtractedTokens {
  if (!isRecord(usage)) return { input: 0, output: 0 };
  return {
    input:
      numberField(usage, "inputTokens") ??
      numberField(usage, "promptTokens") ??
      0,
    output:
      numberField(usage, "outputTokens") ??
      numberField(usage, "completionTokens") ??
      0,
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
