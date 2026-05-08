export function captureArtifactReferences(eventsJsonl: string): string[] {
  const references = new Set<string>();
  for (const line of eventsJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      collectArtifactReferences(JSON.parse(line), references);
    } catch {
      continue;
    }
  }
  return [...references];
}

export function artifactNameFromReference(runId: string, reference: string): string | null {
  const normalized = reference.replace(/\\/g, "/");
  const runPrefix = `.agent-os/runs/${runId}/`;
  const relative = normalized.startsWith(runPrefix) ? normalized.slice(runPrefix.length) : normalized.startsWith("artifacts/") ? normalized : null;
  if (!relative || !relative.startsWith("artifacts/")) return null;
  if (relative.startsWith("/") || relative.includes("\0") || relative.split("/").includes("..")) return null;
  return relative;
}

function collectArtifactReferences(value: unknown, references: Set<string>, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\[full redacted artifact:\s+([^\]\r\n]+)\]/g)) {
      references.add(match[1].trim());
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (typeof object.artifact === "string") references.add(object.artifact);
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectArtifactReferences(item, references, seen);
  }
}
