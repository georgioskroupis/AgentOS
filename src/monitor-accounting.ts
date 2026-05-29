export type MonitorTokenTotals = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export function absoluteThreadTokenTotalsFromMessage(message: Record<string, unknown>): MonitorTokenTotals | null {
  return absoluteThreadTokenTotalsFromParams(recordValue(message.params));
}

export function absoluteThreadTokenTotalsFromParams(params: Record<string, unknown> | null): MonitorTokenTotals | null {
  const tokenUsage = recordValue(params?.tokenUsage);
  if (!tokenUsage) return null;

  const absoluteTotal = tokenTotalsFromValue(tokenUsage.total);
  if (absoluteTotal) return absoluteTotal;

  if (isExplicitAbsoluteUsage(tokenUsage)) return tokenTotalsFromRecord(tokenUsage);
  return null;
}

function isExplicitAbsoluteUsage(value: Record<string, unknown>): boolean {
  const kind = compactString(value.kind ?? value.type ?? value.scope ?? value.level);
  if (kind === "delta" || kind === "incremental" || kind === "turn" || kind === "message") return false;
  if (kind === "total" || kind === "cumulative" || kind === "thread" || kind === "absolute") return true;
  return value.cumulative === true || value.absolute === true || value.isDelta === false;
}

function tokenTotalsFromValue(value: unknown): MonitorTokenTotals | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return { totalTokens: value };
  const record = recordValue(value);
  return record ? tokenTotalsFromRecord(record) : null;
}

function tokenTotalsFromRecord(value: Record<string, unknown>): MonitorTokenTotals | null {
  const inputTokens = nonNegativeInteger(value.inputTokens ?? value.input_tokens ?? value.input);
  const outputTokens = nonNegativeInteger(value.outputTokens ?? value.output_tokens ?? value.output);
  const totalTokens = nonNegativeInteger(value.totalTokens ?? value.total_tokens ?? value.total);
  if (inputTokens == null && outputTokens == null && totalTokens == null) return null;
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(totalTokens != null ? { totalTokens } : {})
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function compactString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
