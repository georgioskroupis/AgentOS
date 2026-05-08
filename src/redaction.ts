const secretPatterns = [
  /ghp_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gho_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /lin_[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Authorization:\s*)(Bearer|token)\s+[A-Za-z0-9._~+/=-]+/gi
];

const sensitiveEnvKey = /(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|PRIVATE_KEY)/i;

export function redactText(input: string, env: NodeJS.ProcessEnv = process.env, extraPatterns: RegExp[] = []): string {
  let output = input;
  for (const pattern of [...secretPatterns, ...extraPatterns]) {
    output = output.replace(pattern, (match, prefix) => `${typeof prefix === "string" ? prefix : ""}[REDACTED]`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !sensitiveEnvKey.test(key)) continue;
    output = output.split(value).join("[REDACTED]");
  }
  return output;
}

export function redactValue<T>(value: T, env: NodeJS.ProcessEnv = process.env, extraPatterns: RegExp[] = []): T {
  return redactValueInner(value, env, extraPatterns, new WeakSet<object>()) as T;
}

function redactValueInner(value: unknown, env: NodeJS.ProcessEnv, extraPatterns: RegExp[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value, env, extraPatterns);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => redactValueInner(item, env, extraPatterns, seen));
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactValueInner(item, env, extraPatterns, seen);
  }
  return out;
}
