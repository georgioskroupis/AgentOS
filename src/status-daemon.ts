import type { RuntimeDaemonState } from "./runtime-state.js";

export function daemonRuntimeDetails(daemon: RuntimeDaemonState | undefined): string[] {
  if (!daemon) return [];
  const lines: string[] = [];
  if (daemon.freshnessStatus) {
    lines.push(`Daemon freshness: ${daemon.freshnessStatus}${daemon.freshnessMessage ? ` - ${daemon.freshnessMessage}` : ""}`);
  }
  if (daemon.preflightStatus) {
    lines.push(`Daemon preflight: ${daemon.preflightStatus}${daemon.preflightMessage ? ` - ${daemon.preflightMessage}` : ""}`);
    if (daemon.repoEnvStatus) lines.push(`Repo env: ${daemon.repoEnvStatus}${daemon.repoEnvPath ? ` (${daemon.repoEnvPath})` : ""}`);
    lines.push(...daemonCredentialDetails(daemon));
  }
  return lines;
}

export function daemonCredentialDetails(daemon: RuntimeDaemonState): string[] {
  const preflight = daemon.credentialPreflight;
  if (!preflight) return [];
  return [
    [
      `Credential availability: tracker=${preflight.tracker.linearApiKey}`,
      `trackerProject=${preflight.tracker.projectSlug}`,
      `githubCommand=${preflight.github.command}`,
      `githubAuth=${preflight.github.auth}`,
      `codexCommand=${preflight.codex.command}`
    ].join("; ")
  ];
}
