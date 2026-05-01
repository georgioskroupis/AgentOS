#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const failures = [];
const focusedTestPattern = /\b(?:describe|it|test)\.only\s*\(/;
const conflictPattern = /^(<<<<<<<|=======|>>>>>>>) /m;

for (const path of trackedFiles()) {
  const text = readFileSync(path, "utf8");
  if (focusedTestPattern.test(text)) failures.push(`${path}: focused test committed`);
  if (conflictPattern.test(text)) failures.push(`${path}: merge conflict marker committed`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`lint: ${failure}`);
  process.exit(1);
}

console.log("Lint check passed.");

function trackedFiles() {
  return execFileSync("git", ["ls-files", "*.ts", "*.js", "*.mjs", "*.md", "*.yml", "*.yaml", "*.sh"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
