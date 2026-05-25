#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures = [];
const indexPath = join(root, "dashboard", "index.html");
const contractPath = join(root, "docs", "architecture", "LEAN_MONITOR_CONTRACT.md");
const manifestPath = join(root, "docs", "architecture", "MONITOR_DELETION_MANIFEST.md");

const html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
const contract = existsSync(contractPath) ? readFileSync(contractPath, "utf8") : "";

if (!html) failures.push("dashboard/index.html is required");
if (!html.includes("AgentOS Monitor")) failures.push("dashboard/index.html must keep a visible monitor title");
for (const section of ["Run Header", "Tiny Summary", "Current Activity", "Nested Timing Table", "Top Time Sinks", "Human Action", "Links"]) {
  if (!html.includes(section)) failures.push(`dashboard/index.html must render lean monitor section ${section}`);
  if (!contract.includes(section)) failures.push(`lean monitor contract must define UI section ${section}`);
}

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

for (const forbidden of ["https://cdn.", "https://unpkg.com", "tailwind", "ReactDOM"]) {
  if (html.includes(forbidden)) failures.push(`dashboard/index.html must not depend on ${forbidden}`);
}

const dashboardHtmlForbidden = [
  { label: "old monitor API route", regex: /\/api\/v1\// },
  { label: "browser fetch state reconstruction", regex: /\bfetch\s*\(/ },
  { label: "old refresh control", regex: /\b(refresh|reconcile|pause|resume)\b/i },
  { label: "browser mutation control", regex: /<button\b|method=["']post["']|type=["']submit["']/i },
  { label: "legacy live monitor support", regex: /\.live\b/ }
];

for (const forbidden of dashboardHtmlForbidden) {
  if (forbidden.regex.test(html)) failures.push(`dashboard/index.html must not contain ${forbidden.label}`);
}

if (!existsSync(contractPath)) failures.push("docs/architecture/LEAN_MONITOR_CONTRACT.md is required for the lean monitor boundary");
if (!existsSync(manifestPath)) failures.push("docs/architecture/MONITOR_DELETION_MANIFEST.md is required as the historical deletion manifest");

const forbiddenTerms = [
  { term: "POST /api/v1/refresh", regex: /POST\s+\/api\/v1\/refresh/ },
  { term: "/api/v1/refresh", regex: /\/api\/v1\/refresh/ },
  { term: "/api/v1/state", regex: /\/api\/v1\/state/ },
  { term: "onRefresh", regex: /\bonRefresh\b/ },
  { term: ".live", regex: /\.live\b/ },
  { term: "legacy dashboard", regex: /\blegacy dashboard\b/i },
  { term: "browser-side state reconstruction", regex: /\bbrowser-side state reconstruction\b/i }
];

for (const path of scannedFiles()) {
  const text = readFileSync(join(root, path), "utf8");
  for (const forbidden of forbiddenTerms) {
    if (forbidden.regex.test(text)) failures.push(`${path} contains forbidden legacy monitor term ${forbidden.term}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

function scannedFiles() {
  const roots = ["src", "dashboard", "tests", "docs", "WORKFLOW.md"];
  const files = [];
  for (const entry of roots) {
    const absolute = join(root, entry);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isFile()) {
      files.push(entry);
      continue;
    }
    for (const file of walk(absolute)) files.push(relative(root, file));
  }
  return files
    .filter((path) => /\.(ts|js|mjs|html|md|sh|json|yml)$/.test(path) || path === "WORKFLOW.md")
    .filter((path) => !legacyAllowlist(path));
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function legacyAllowlist(path) {
  return (
    path === "scripts/check-dashboard.mjs" ||
    path === "docs/architecture/MONITOR_DELETION_MANIFEST.md" ||
    path.startsWith("docs/releases/") ||
    path.startsWith("docs/planning/")
  );
}
