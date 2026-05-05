import { chmod, copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

const cliScript = resolve("src/cli.ts");
const sourceScripts = resolve("scripts");

describe("agent lifecycle CLI", () => {
  it("passes stable lifecycle action and tool arguments from repo-local wrappers", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-wrapper-"));
    const fakeBin = join(repo, "fake-bin");
    const capture = join(repo, "capture.log");
    await mkdir(join(repo, "scripts"), { recursive: true });
    await writeFakeAgentOs(fakeBin, capture);

    const cases = [
      {
        script: "agent-linear-comment.sh",
        args: ["AG-1", "--event", "status_update", "Body"],
        expected: `args: <linear> <lifecycle> <comment> <AG-1> <--event> <status_update> <Body> <--repo> <${repo}> <--workflow> <WORKFLOW.md> <--tool> <scripts/agent-linear-comment.sh>`
      },
      {
        script: "agent-linear-move.sh",
        args: ["AG-1", "Human Review"],
        expected: `args: <linear> <lifecycle> <move> <AG-1> <Human Review> <--repo> <${repo}> <--workflow> <WORKFLOW.md> <--tool> <scripts/agent-linear-move.sh>`
      },
      {
        script: "agent-linear-pr.sh",
        args: ["AG-1", "https://github.com/o/r/pull/36"],
        expected: `args: <linear> <lifecycle> <attach-pr> <AG-1> <https://github.com/o/r/pull/36> <--repo> <${repo}> <--workflow> <WORKFLOW.md> <--tool> <scripts/agent-linear-pr.sh>`
      },
      {
        script: "agent-linear-handoff.sh",
        args: ["AG-1", "--file", ".agent-os/handoff-AG-1.md"],
        expected: `args: <linear> <lifecycle> <record-handoff> <AG-1> <--file> <.agent-os/handoff-AG-1.md> <--repo> <${repo}> <--workflow> <WORKFLOW.md> <--tool> <scripts/agent-linear-handoff.sh>`
      }
    ];

    for (const item of cases) {
      const target = join(repo, "scripts", item.script);
      await copyFile(join(sourceScripts, item.script), target);
      await chmod(target, 0o755);
      await execOk(target, item.args, {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        AGENT_OS_WRAPPER_CAPTURE: capture
      });
    }

    const logged = await readFile(capture, "utf8");
    for (const item of cases) {
      expect(logged).toContain(item.expected);
    }
  });

  it("lets repo-local wrappers override caller-supplied policy options with fixed trusted values", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-wrapper-policy-"));
    const fakeBin = join(repo, "fake-bin");
    const capture = join(repo, "capture.log");
    await mkdir(join(repo, "scripts"), { recursive: true });
    await writeFakeAgentOs(fakeBin, capture);
    const target = join(repo, "scripts", "agent-linear-comment.sh");
    await copyFile(join(sourceScripts, "agent-linear-comment.sh"), target);
    await chmod(target, 0o755);

    await execOk(
      target,
      [
        "AG-1",
        "--event",
        "status_update",
        "--repo",
        "/tmp/evil",
        "--workflow",
        "/tmp/permissive.md",
        "--tool",
        "agent-os linear lifecycle move",
        "Body"
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        AGENT_OS_WRAPPER_CAPTURE: capture
      }
    );

    const logged = await readFile(capture, "utf8");
    expect(logged).toContain(`<--repo> </tmp/evil> <--workflow> </tmp/permissive.md> <--tool> <agent-os linear lifecycle move> <Body> <--repo> <${repo}> <--workflow> <WORKFLOW.md> <--tool> <scripts/agent-linear-comment.sh>`);
  });

  it("rejects direct lifecycle action/tool mismatches before loading workflow config", async () => {
    const result = await execCliFail([
      "linear",
      "lifecycle",
      "move",
      "AG-1",
      "Human Review",
      "--tool",
      "scripts/agent-linear-comment.sh"
    ]);

    expect(result.stderr).toContain("lifecycle tool/action mismatch: move cannot use scripts/agent-linear-comment.sh");
  });

  it("rejects lifecycle tracker writes when allowed tracker tools are not declared", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-missing-allowlist-"));
    await writeWorkflow(repo, []);

    const result = await execCliFail([
      "linear",
      "lifecycle",
      "comment",
      "AG-1",
      "--event",
      "status_update",
      "--repo",
      repo,
      "--workflow",
      "WORKFLOW.md",
      "--tool",
      "scripts/agent-linear-comment.sh",
      "hello"
    ]);

    expect(result.stderr).toContain("lifecycle.allowed_tracker_tools is required for agent tracker writes");
  });

  it("rejects lifecycle workflow paths that are absolute or escape the repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-workflow-"));
    const outside = join(await mkdtemp(join(tmpdir(), "agent-os-lifecycle-outside-")), "WORKFLOW.md");
    await writeWorkflow(repo);
    await writeFile(outside, "---\nlifecycle:\n  mode: hybrid\ntracker:\n  kind: linear\n  api_key: lin_test\n  project_slug: AgentOS\n---\nDo work", "utf8");

    const absolute = await execCliFail([
      "linear",
      "lifecycle",
      "comment",
      "AG-1",
      "--event",
      "status_update",
      "--repo",
      repo,
      "--workflow",
      outside,
      "--tool",
      "scripts/agent-linear-comment.sh",
      "hello"
    ]);
    expect(absolute.stderr).toContain("workflow path must be relative to the repository root");

    const escaped = await execCliFail([
      "linear",
      "lifecycle",
      "comment",
      "AG-1",
      "--event",
      "status_update",
      "--repo",
      repo,
      "--workflow",
      "../WORKFLOW.md",
      "--tool",
      "scripts/agent-linear-comment.sh",
      "hello"
    ]);
    expect(escaped.stderr).toContain("workflow path must stay within the repository root");
  });

  it("rejects lifecycle comment files that are absolute or escape the repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-file-"));
    const outside = join(await mkdtemp(join(tmpdir(), "agent-os-lifecycle-secret-")), "secret.md");
    await writeWorkflow(repo);
    await writeFile(outside, "secret", "utf8");

    const absolute = await execCliFail([
      "linear",
      "lifecycle",
      "comment",
      "AG-1",
      "--event",
      "status_update",
      "--repo",
      repo,
      "--workflow",
      "WORKFLOW.md",
      "--tool",
      "scripts/agent-linear-comment.sh",
      "--file",
      outside
    ]);
    expect(absolute.stderr).toContain("comment body file must be relative to the repository root");

    const escaped = await execCliFail([
      "linear",
      "lifecycle",
      "comment",
      "AG-1",
      "--event",
      "status_update",
      "--repo",
      repo,
      "--workflow",
      "WORKFLOW.md",
      "--tool",
      "scripts/agent-linear-comment.sh",
      "--file",
      "../secret.md"
    ]);
    expect(escaped.stderr).toContain("comment body file must stay within the repository root");
  });

  it("rejects repo-relative lifecycle files symlinked outside the repo before reading them", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-symlink-"));
    const outside = join(await mkdtemp(join(tmpdir(), "agent-os-lifecycle-secret-")), "secret.md");
    const linked = join(repo, ".agent-os", "status.md");
    await writeWorkflow(repo);
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(outside, "secret lifecycle body", "utf8");
    await symlink(outside, linked);

    const result = await execCliFail([
      "linear",
      "lifecycle",
      "comment",
      "AG-1",
      "--event",
      "status_update",
      "--repo",
      repo,
      "--workflow",
      "WORKFLOW.md",
      "--tool",
      "scripts/agent-linear-comment.sh",
      "--file",
      ".agent-os/status.md"
    ]);

    expect(result.stderr).toContain("comment body file must stay within the repository root");
    expect(result.stderr).not.toContain("secret lifecycle body");
  });
});

async function execOk(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function execFail(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (!error) {
        reject(new Error(`expected command to fail: ${command} ${args.join(" ")}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function execCliFail(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFail(process.execPath, ["--import", "tsx", cliScript, ...args]);
}

async function writeFakeAgentOs(fakeBin: string, capture: string): Promise<void> {
  await mkdir(fakeBin, { recursive: true });
  const path = join(fakeBin, "agent-os");
  await writeFile(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "mkdir -p \"$(dirname \"$AGENT_OS_WRAPPER_CAPTURE\")\"",
      "{",
      "  printf 'args:'",
      "  for arg in \"$@\"; do printf ' <%s>' \"$arg\"; done",
      "  printf '\\n'",
      "} >> \"$AGENT_OS_WRAPPER_CAPTURE\"",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}

async function writeWorkflow(repo: string, allowedTrackerTools = ["scripts/agent-linear-comment.sh"]): Promise<void> {
  await writeFile(
    join(repo, "WORKFLOW.md"),
    [
      "---",
      "lifecycle:",
      "  mode: hybrid",
      ...(allowedTrackerTools.length > 0 ? ["  allowed_tracker_tools:", ...allowedTrackerTools.map((tool) => `    - ${tool}`)] : []),
      "tracker:",
      "  kind: linear",
      "  api_key: lin_test",
      "  project_slug: AgentOS",
      "---",
      "Do work"
    ].join("\n"),
    "utf8"
  );
}
