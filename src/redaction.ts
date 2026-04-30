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
  if (typeof value === "string") return redactText(value, env, extraPatterns) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, env, extraPatterns)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactValue(item, env, extraPatterns);
  }
  return out as T;
}
