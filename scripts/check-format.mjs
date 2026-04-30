#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const failures = [];

for (const path of trackedFiles()) {
  const data = readFileSync(path);
  if (data.includes(0)) continue;
  const text = data.toString("utf8");
  if (text.includes("\r\n")) failures.push(`${path}: CRLF line endings`);
  if (/[ \t]$/m.test(text)) failures.push(`${path}: trailing whitespace`);
  if (text.length > 0 && !text.endsWith("\n")) failures.push(`${path}: missing final newline`);
  if (/\n\n$/.test(text)) failures.push(`${path}: extra blank line at EOF`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`format: ${failure}`);
  process.exit(1);
}

console.log("Format check passed.");

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
