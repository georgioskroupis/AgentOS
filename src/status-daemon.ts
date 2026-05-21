import { join, resolve } from "node:path";
import { inspectDaemonHealth } from "./daemon-health.js";
import { RuntimeStateStore, type RuntimeDaemonState } from "./runtime-state.js";

export async function getDaemonStatus(repo = process.cwd()): Promise<string> {
  const root = resolve(repo);
  const health = await inspectDaemonHealth(root);
  const runtime = await new RuntimeStateStore(root).read();
  const runLogPath = join(root, ".agent-os", "runs", "agent-os.jsonl");
  return [
    `Daemon: ${health.status} - ${health.message}`,
    `PID file: ${health.pidPath}`,
    `Run events: ${runLogPath}`,
    `Crash log: ${health.logPath}`,
    `Next safe action: ${health.nextSafeAction}; inspect ${runLogPath} for normal diagnostics and use ${health.logPath} only for crash investigations`,
    ...daemonRuntimeDetails(runtime.daemon)
  ].join("\n");
}

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
