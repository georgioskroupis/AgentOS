#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const gates = [
  { name: "source-core", command: "npm", args: ["run", "certification:source-core"] },
  { name: "extensions", command: "npm", args: ["run", "certification:extensions"] }
];
const results = [];

for (const gate of gates) {
  console.log(`certification gate start: ${gate.name}`);
  const startedAt = Date.now();
  const result = spawnSync(gate.command, gate.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    maxBuffer: 30 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const elapsedMs = Date.now() - startedAt;
  results.push({ gate: gate.name, status: result.status === 0 ? "passed" : "failed", exitCode: result.status, elapsedMs });
  console.log(`certification gate ${result.status === 0 ? "passed" : "failed"}: ${gate.name} (${elapsedMs}ms)`);
  if (result.status !== 0) break;
}

console.log("certification gate summary:");
for (const result of results) {
  console.log(`- ${result.gate}: ${result.status} (exit ${result.exitCode}, ${result.elapsedMs}ms)`);
}
console.log("- live-e2e: separate credential-gated proof via npm run certification:live-e2e");

if (results.some((result) => result.status !== "passed") || results.length !== gates.length) process.exit(1);
console.log("AgentOS agent-owned aggregate certification passed.");
