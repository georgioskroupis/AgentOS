#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const indexPath = join(root, "dashboard", "index.html");
const html = readFileSync(indexPath, "utf8");
const failures = [];

for (const required of ["/api/v1/state", "/api/v1/refresh", "AgentOS Monitor"]) {
  if (!html.includes(required)) failures.push(`dashboard/index.html must include ${required}`);
}

for (const forbidden of ["https://cdn.", "https://unpkg.com", "tailwind", "ReactDOM", ".live/"]) {
  if (html.includes(forbidden)) failures.push(`dashboard/index.html must not depend on ${forbidden}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
