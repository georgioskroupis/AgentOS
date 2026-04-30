#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const secretPattern = /(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|lin_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const failures = [];

for (const path of [...trackedFiles(), ...runtimeArtifactFiles()]) {
  const data = readFileSync(path);
  if (data.includes(0)) continue;
  if (secretPattern.test(data.toString("utf8"))) failures.push(`${path}: token-shaped secret`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`security: ${failure}`);
  process.exit(1);
}

console.log("Security check passed.");

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function runtimeArtifactFiles() {
  const roots = [join(".agent-os", "runs"), join(".agent-os", "validation")];
  const out = [];
  for (const root of roots) {
    if (existsSync(root)) walk(root, out);
  }
  return out;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (stat.isFile()) out.push(path);
  }
}
