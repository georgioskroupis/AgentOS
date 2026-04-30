#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const failures = [];

checkNoImports("src/types.ts", ["./", "../"]);
checkNoImports("src/runner/app-server.ts", ["../orchestrator", "../linear", "../github", "../workspace"]);
checkNoImports("src/fs-utils.ts", ["./orchestrator", "./linear", "./github"]);
checkCliDoesNotOwnDomainLogic();

if (failures.length > 0) {
  for (const failure of failures) console.error(`architecture: ${failure}`);
  process.exit(1);
}

console.log("Architecture check passed.");

function checkNoImports(path, disallowed) {
  const text = readFileSync(path, "utf8");
  for (const target of disallowed) {
    const pattern = new RegExp(`from\\s+["']${escapeRegExp(target)}`);
    if (pattern.test(text)) failures.push(`${path}: imports disallowed boundary ${target}`);
  }
}

function checkCliDoesNotOwnDomainLogic() {
  const text = readFileSync(join("src", "cli.ts"), "utf8");
  for (const snippet of ["class Orchestrator", "class LinearClient", "class WorkspaceManager"]) {
    if (text.includes(snippet)) failures.push(`src/cli.ts: owns domain class ${snippet}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
