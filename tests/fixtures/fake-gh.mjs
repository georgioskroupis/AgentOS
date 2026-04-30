#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.GH_FAKE_STATE;
const args = process.argv.slice(2);

if (!statePath) {
  console.error("GH_FAKE_STATE is required");
  process.exit(2);
}

const state = JSON.parse(readFileSync(statePath, "utf8"));

if (args[0] === "auth" && args[1] === "status") {
  console.log("Logged in to github.com");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify(state.view));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "merge") {
  if (state.mergeError) {
    console.error(state.mergeError);
    process.exit(1);
  }
  state.mergedWith = args.slice(2);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log("Merged");
  process.exit(0);
}

console.error(`unexpected gh args: ${args.join(" ")}`);
process.exit(1);
