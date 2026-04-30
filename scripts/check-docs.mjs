#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const failures = [];
const requiredDocs = [
  "README.md",
  "ARCHITECTURE.md",
  "WORKFLOW.md",
  "docs/README.md",
  "docs/architecture/AGENT_OS.md",
  "docs/product/README.md",
  "docs/quality/QUALITY_SCORE.md",
  "docs/runbooks/LINEAR_SETUP.md",
  "docs/runbooks/ROLLOUT.md",
  "docs/runbooks/MIGRATIONS.md",
  "docs/security/SECURITY.md",
  "docs/security/ORCHESTRATOR_TRUST_MODEL.md"
];

for (const path of requiredDocs) {
  if (!existsSync(path)) failures.push(`missing required doc ${path}`);
}

const cli = readFileSync("src/cli.ts", "utf8");
const readme = readFileSync("README.md", "utf8");
for (const command of ["setup", "init", "doctor", "check", "orchestrator", "status", "inspect", "linear", "codex-doctor"]) {
  if (!readme.includes(`agent-os ${command}`) && !readme.includes(`### \`${command}`)) failures.push(`README.md does not mention command ${command}`);
  if (!cli.includes(`.command("${command}")`) && !cli.includes(`program.command("${command}")`) && !cli.includes(`const ${command} = program.command("${command}")`)) {
    failures.push(`src/cli.ts does not define documented command ${command}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`docs: ${failure}`);
  process.exit(1);
}

console.log("Docs check passed.");
