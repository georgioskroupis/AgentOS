export function isBenignCodexPluginStderr(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const lower = line.toLowerCase();
    const mentionsPluginManifest = /plugin|manifest|\.codex-plugin|plugin\.json|codex_core_plugins/.test(lower);
    const looksLikeWarning = /warn|warning|ignoring interface\.defaultprompt|maximum of 3 prompts/.test(lower);
    return mentionsPluginManifest && looksLikeWarning;
  });
}
