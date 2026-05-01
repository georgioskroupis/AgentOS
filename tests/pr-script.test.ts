import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/agent-create-pr.sh");

describe("agent-create-pr.sh", () => {
  it("creates PRs through explicit non-interactive gh arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-pr-script-"));
    const fakeBin = join(dir, "bin");
    const capture = join(dir, "capture.log");
    const bodyFile = join(dir, "pr-body.md");
    await writeFile(bodyFile, "## Summary\n\nDocs only.\n", "utf8");
    await writeFakeGh(fakeBin, capture);

    const result = await execScript(
      [
        "--title",
        "Add docs note",
        "--body-file",
        bodyFile,
        "--base",
        "main",
        "--head",
        "agent/VER-36",
        "--draft",
        "--repo",
        "georgioskroupis/AgentOS"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_CAPTURE: capture }
    );

    expect(result.stdout.trim()).toBe("https://github.com/georgioskroupis/AgentOS/pull/36");
    const logged = await readFile(capture, "utf8");
    expect(logged).toContain("GH_PROMPT_DISABLED=1");
    expect(logged).toContain("args: <pr> <view> <--repo> <georgioskroupis/AgentOS> <--head> <agent/VER-36> <--json> <url> <--jq> <.url>");
    expect(logged).toContain(
      "args: <pr> <create> <--repo> <georgioskroupis/AgentOS> <--title> <Add docs note> <--body-file>"
    );
    expect(logged).toContain("<--base> <main> <--head> <agent/VER-36> <--draft>");
    expect(logged).not.toMatch(/mcp|elicitation|approval/i);
  });

  it("returns an existing PR for the head branch instead of creating another one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-pr-existing-"));
    const fakeBin = join(dir, "bin");
    const capture = join(dir, "capture.log");
    const bodyFile = join(dir, "pr-body.md");
    await writeFile(bodyFile, "## Summary\n\nAlready pushed.\n", "utf8");
    await writeFakeGh(fakeBin, capture);

    const result = await execScript(
      ["--title", "Existing", "--body-file", bodyFile, "--base", "main", "--head", "agent/VER-36"],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_CAPTURE: capture, GH_FAKE_EXISTING_PR: "1" }
    );

    expect(result.stdout.trim()).toBe("https://github.com/georgioskroupis/AgentOS/pull/existing");
    const logged = await readFile(capture, "utf8");
    expect(logged).toContain("args: <pr> <view>");
    expect(logged).not.toContain("args: <pr> <create>");
  });
});

async function execScript(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(script, args, { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function writeFakeGh(fakeBin: string, capture: string): Promise<void> {
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(fakeBin, "gh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "mkdir -p \"$(dirname \"$GH_CAPTURE\")\"",
      "{",
      "  printf 'GH_PROMPT_DISABLED=%s\\n' \"${GH_PROMPT_DISABLED:-}\"",
      "  printf 'args:'",
      "  for arg in \"$@\"; do printf ' <%s>' \"$arg\"; done",
      "  printf '\\n'",
      "} >> \"$GH_CAPTURE\"",
      "if [[ \"$1\" == \"pr\" && \"$2\" == \"view\" ]]; then",
      "  if [[ \"${GH_FAKE_EXISTING_PR:-}\" == \"1\" ]]; then",
      "    echo 'https://github.com/georgioskroupis/AgentOS/pull/existing'",
      "    exit 0",
      "  fi",
      "  exit 1",
      "fi",
      "if [[ \"$1\" == \"pr\" && \"$2\" == \"create\" ]]; then",
      "  echo 'https://github.com/georgioskroupis/AgentOS/pull/36'",
      "  exit 0",
      "fi",
      "exit 3",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(join(fakeBin, "gh"), 0o755);
}
