#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const indexPath = join(root, "dashboard", "index.html");
const html = readFileSync(indexPath, "utf8");
const contractPath = join(root, "docs", "architecture", "LEAN_MONITOR_CONTRACT.md");
const manifestPath = join(root, "docs", "architecture", "MONITOR_DELETION_MANIFEST.md");
const failures = [];

for (const forbidden of ["https://cdn.", "https://unpkg.com", "tailwind", "ReactDOM", ".live/"]) {
  if (html.includes(forbidden)) failures.push(`dashboard/index.html must not depend on ${forbidden}`);
}

if (!html.includes("AgentOS Monitor")) failures.push("dashboard/index.html must keep a visible monitor title while the legacy dashboard remains present");

if (!existsSync(contractPath)) failures.push("docs/architecture/LEAN_MONITOR_CONTRACT.md is required for the lean monitor boundary");
if (!existsSync(manifestPath)) failures.push("docs/architecture/MONITOR_DELETION_MANIFEST.md is required before legacy monitor deletion work");

const contract = existsSync(contractPath) ? readFileSync(contractPath, "utf8") : "";
const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";

for (const token of [
  "MonitorSink",
  "MonitorEvent",
  "NullMonitorSink",
  "MonitorSnapshot",
  "TimingRow",
  "TimeSink",
  "HumanAction",
  "LauncherState",
  "LauncherConfig"
]) {
  if (!contract.includes(token)) failures.push(`lean monitor contract must define ${token}`);
}

for (const section of ["Run Header", "Tiny Summary", "Current Activity", "Nested Timing Table", "Top Time Sinks", "Human Action", "Links"]) {
  if (!contract.includes(section)) failures.push(`lean monitor contract must define UI section ${section}`);
}

for (const term of [
  "POST /api/v1/refresh",
  "/api/v1/refresh",
  "/api/v1/state",
  "old monitor issue-route pattern",
  "onRefresh",
  ".live",
  "legacy dashboard",
  "browser-side state reconstruction"
]) {
  if (!manifest.includes(term)) failures.push(`monitor deletion manifest must list forbidden legacy term ${term}`);
}

const normalizedManifest = manifest.toLowerCase();
for (const allowlist of ["deletion manifest", "historical docs", "check implementation itself"]) {
  if (!normalizedManifest.includes(allowlist)) failures.push(`monitor deletion manifest must document forbidden-term allowlist for ${allowlist}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
