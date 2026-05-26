#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures = [];
const indexPath = join(root, "dashboard", "index.html");
const contractPath = join(root, "docs", "architecture", "LEAN_MONITOR_CONTRACT.md");
const manifestPath = join(root, "docs", "architecture", "MONITOR_DELETION_MANIFEST.md");
const macosAppPath = join(root, "src", "monitor-macos-app.ts");
const dashboardReadmePath = join(root, "dashboard", "README.md");
const rolloutRunbookPath = join(root, "docs", "runbooks", "ROLLOUT.md");
const workflowPath = join(root, "WORKFLOW.md");

const html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
const contract = existsSync(contractPath) ? readFileSync(contractPath, "utf8") : "";
const macosApp = existsSync(macosAppPath) ? readFileSync(macosAppPath, "utf8") : "";
const dashboardReadme = existsSync(dashboardReadmePath) ? readFileSync(dashboardReadmePath, "utf8") : "";
const rolloutRunbook = existsSync(rolloutRunbookPath) ? readFileSync(rolloutRunbookPath, "utf8") : "";
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";

if (!html) failures.push("dashboard/index.html is required");
if (!html.includes("AgentOS Monitor")) failures.push("dashboard/index.html must keep a visible monitor title");
const profilerSections = ["Run Header", "Tiny Summary", "Current Activity", "Nested Timing Table", "Top Time Sinks", "Human Action", "Links"];
for (const section of profilerSections) {
  if (!html.includes(section)) failures.push(`dashboard/index.html must render lean monitor section ${section}`);
  if (!contract.includes(section)) failures.push(`lean monitor contract must define UI section ${section}`);
}

const initialMain = html.match(/<main[^>]*id=["']profiler["'][^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? "";
const initialSections = [...initialMain.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1].trim());
if (JSON.stringify(initialSections) !== JSON.stringify(profilerSections)) {
  failures.push(`dashboard/index.html must render exactly seven profiler sections in order; found ${initialSections.join(", ") || "none"}`);
}

for (const route of ["/api/monitor/v1/snapshot", "/api/monitor/v1/stream"]) {
  if (!html.includes(route)) failures.push(`dashboard/index.html must read ${route}`);
}
for (const route of ["/api/monitor/v1/snapshot", "/api/monitor/v1/stream", "/api/monitor/v1/health"]) {
  if (!workflow.includes(route)) failures.push(`WORKFLOW.md must document read-only monitor route ${route}`);
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
  { label: "old refresh control", regex: /\b(refresh|reconcile|pause|resume)\b/i },
  { label: "browser form mutation control", regex: /method=["']post["']|type=["']submit["']/i },
  { label: "legacy live monitor support", regex: /\.live\b/ }
];

for (const forbidden of dashboardHtmlForbidden) {
  if (forbidden.regex.test(html)) failures.push(`dashboard/index.html must not contain ${forbidden.label}`);
}

for (const forbidden of ["tablist", "side nav", "history", "analytics", "evidence page", "debug page", "prompt viewer", "raw log viewer"]) {
  if (html.toLowerCase().includes(forbidden)) failures.push(`dashboard/index.html must not contain ${forbidden}`);
}

if (!html.includes("data-mode=\"browser\"")) failures.push("dashboard/index.html must default to browser mode");
if (!html.includes("mode\") === \"standalone\"")) failures.push("dashboard/index.html must gate the launcher strip to standalone mode");
if ((html.match(/aria-disabled=["']true["']/g) ?? []).length < 4) failures.push("dashboard/index.html must render disabled placeholders for missing links");
if (!html.includes("Not needed")) failures.push("dashboard/index.html must render Human Action as Not needed by default");

if (!existsSync(contractPath)) failures.push("docs/architecture/LEAN_MONITOR_CONTRACT.md is required for the lean monitor boundary");
if (!existsSync(manifestPath)) failures.push("docs/architecture/MONITOR_DELETION_MANIFEST.md is required as the historical deletion manifest");
if (!macosApp) failures.push("src/monitor-macos-app.ts is required for the standalone macOS monitor app installer");
for (const token of ["AgentOS Monitor.app", "BrowserWindow", "contextBridge.exposeInMainWorld", "agentos-launcher:start", "LauncherConfig"]) {
  if (!macosApp.includes(token)) failures.push(`src/monitor-macos-app.ts must include standalone app token ${token}`);
}
for (const [path, text] of [
  ["dashboard/README.md", dashboardReadme],
  ["docs/runbooks/ROLLOUT.md", rolloutRunbook]
]) {
  if (!text.includes("browser") || !text.includes("read-only")) failures.push(`${path} must document read-only browser mode`);
  if (!text.includes("Dock")) failures.push(`${path} must document Dock setup`);
  if (!text.includes("launcher-owned")) failures.push(`${path} must document launcher-owned process behavior`);
  if (!text.includes("externally managed")) failures.push(`${path} must document externally managed process behavior`);
  if (!text.includes("Stop")) failures.push(`${path} must document Stop behavior`);
}
if (workflow.includes("runtime snapshot serving belongs to future")) failures.push("WORKFLOW.md must not describe monitor snapshot serving as future work");

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
