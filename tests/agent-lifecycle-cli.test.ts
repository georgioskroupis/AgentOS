import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { writeValidationEvidence } from "../src/validation.js";
import { validationReuseProfileForConfig } from "../src/validation-profile.js";
import { loadWorkflow, resolveServiceConfig } from "../src/workflow.js";

const cliScript = resolve("src/cli.ts");
const sourceScripts = resolve("scripts");

describe("agent lifecycle CLI", () => {
  it("loads repo-local env for operator-facing Linear helpers", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-linear-env-cli-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "env"), "LINEAR_API_KEY=lin_from_file\n", "utf8");

    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { teams: { nodes: [{ id: "team-1", key: "VER", name: "VerityStudio" }] } } }));
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as { port: number }).port;
    await writeFile(
      join(repo, "WORKFLOW.md"),
      ["---", "tracker:", "  kind: linear", `  endpoint: http://127.0.0.1:${port}/graphql`, "  api_key: $LINEAR_API_KEY", "  project_slug: AgentOS", "---", "Do work"].join("\n"),
      "utf8"
    );

    try {
      const result = await execOk(process.execPath, ["--import", "tsx", cliScript, "linear", "teams", "--workflow", join(repo, "WORKFLOW.md")], { LINEAR_API_KEY: "" });

      expect(result.stdout).toContain("VER\tteam-1\tVerityStudio");
      expect(authorization).toBe("lin_from_file");
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

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

  it("rejects supervisor moves for missing identifiers without a Linear write", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-supervisor-missing-cli-"));
    let writeCount = 0;
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        const payload = JSON.parse(raw) as { query: string };
        if (payload.query.includes("AgentOSIssueMove")) writeCount += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { issues: { nodes: [] } } }));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as { port: number }).port;
    await writeSupervisorWorkflow(repo, `http://127.0.0.1:${port}/graphql`);

    try {
      const result = await execFail(process.execPath, [
        "--import",
        "tsx",
        cliScript,
        "supervisor",
        "move",
        "AG-404",
        "Merging",
        "--repo",
        repo,
        "--workflow",
        "WORKFLOW.md"
      ]);

      expect(result.stderr).toContain("Linear issue not found: AG-404");
      expect(writeCount).toBe(0);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("posts supervisor decisions with the structured WORKFLOW.md payload", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-supervisor-decide-cli-"));
    await mkdir(join(repo, ".agent-os", "validation"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "validation", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueIdentifier: "AG-1",
          repoHead: "abc1234",
          status: "passed",
          commands: [
            {
              name: "npm run agent-check",
              exitCode: 0,
              startedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:01:00.000Z"
            }
          ],
          reuseProfile: {
            workflowConfigHash: "hash",
            trustMode: "danger",
            automationProfile: "high-throughput",
            automationRepairPolicy: "mechanical-first",
            riskProfile: "review=enabled"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    let createdBody = "";
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        const payload = JSON.parse(raw) as { query: string; variables?: Record<string, any> };
        response.writeHead(200, { "content-type": "application/json" });
        if (payload.query.includes("AgentOSFindIssue")) {
          response.end(JSON.stringify({ data: { issues: { nodes: [linearIssueNode("AG-1")] } } }));
          return;
        }
        if (payload.query.includes("AgentOSIssueComments")) {
          response.end(JSON.stringify({ data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
          return;
        }
        if (payload.query.includes("AgentOSComment")) {
          createdBody = String(payload.variables?.input?.body ?? "");
          response.end(JSON.stringify({ data: { commentCreate: { success: true } } }));
          return;
        }
        response.end(JSON.stringify({ data: {} }));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as { port: number }).port;
    await writeSupervisorWorkflow(repo, `http://127.0.0.1:${port}/graphql`);

    try {
      const result = await execOk(process.execPath, [
        "--import",
        "tsx",
        cliScript,
        "supervisor",
        "decide",
        "AG-1",
        "fix-findings",
        "--validation",
        ".agent-os/validation/AG-1.json",
        "--pr-head-sha",
        "abc1234",
        "--ci-state",
        "passed",
        "--findings",
        "resolved",
        "--summary",
        "review findings are resolved",
        "--repo",
        repo,
        "--workflow",
        "WORKFLOW.md"
      ]);

      expect(result.stdout).toContain("created: AG-1");
      expect(createdBody).toContain("<!-- agentos:event=supervisor-decision:fix-findings:abc1234 issue=AG-1 run=manual attempt=manual -->");
      expect(createdBody).toContain(
        [
          "AgentOS-Human-Decision: fix-findings",
          "PR-Head-SHA: abc1234",
          "Validation-JSON: .agent-os/validation/AG-1.json",
          "CI-State: passed",
          "Findings: resolved",
          "Decision-Summary: review findings are resolved"
        ].join("\n")
      );
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
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

    expect(result.stderr).toContain("lifecycle.mode=agent-owned requires lifecycle.allowed_tracker_tools in strict mode");
  });

  it("emits machine-readable JSON with lifecycle correlation and redacted tracker bodies", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-json-cli-"));
    let createdBody = "";
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        const payload = JSON.parse(raw) as { query: string; variables?: Record<string, any> };
        response.writeHead(200, { "content-type": "application/json" });
        if (payload.query.includes("AgentOSFindIssue")) {
          response.end(JSON.stringify({ data: { issues: { nodes: [linearIssueNode("AG-1")] } } }));
          return;
        }
        if (payload.query.includes("AgentOSIssueComments")) {
          response.end(JSON.stringify({ data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
          return;
        }
        if (payload.query.includes("AgentOSComment")) {
          createdBody = String(payload.variables?.input?.body ?? "");
          response.end(JSON.stringify({ data: { commentCreate: { success: true } } }));
          return;
        }
        response.end(JSON.stringify({ data: {} }));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as { port: number }).port;
    await writeAgentOwnedWorkflow(repo, `http://127.0.0.1:${port}/graphql`);

    try {
      const token = `lin_${"a".repeat(26)}`;
      const result = await execOk(process.execPath, [
        "--import",
        "tsx",
        cliScript,
        "linear",
        "lifecycle",
        "comment",
        "AG-1",
        "--event",
        "status_update",
        "--run-id",
        "run-123",
        "--attempt",
        "0",
        "--repo",
        repo,
        "--workflow",
        "WORKFLOW.md",
        "--tool",
        "scripts/agent-linear-comment.sh",
        `done ${token}`
      ]);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      expect(parsed).toEqual({
        schemaVersion: 1,
        status: "created",
        issueIdentifier: "AG-1",
        marker: "<!-- agentos:event=status_update issue=AG-1 run=run-123 attempt=0 -->",
        runId: "run-123",
        attempt: 0
      });
      expect(result.stdout).not.toContain(token);
      expect(result.stderr).not.toContain(token);
      expect(createdBody).toContain("<!-- agentos:event=status_update issue=AG-1 run=run-123 attempt=0 -->");
      expect(createdBody).toContain("done [REDACTED]");
      expect(createdBody).not.toContain(token);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("emits a marker-correlated JSON result for agent-owned moves", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-move-json-cli-"));
    let movedInput: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        const payload = JSON.parse(raw) as { query: string; variables?: Record<string, any> };
        response.writeHead(200, { "content-type": "application/json" });
        if (payload.query.includes("AgentOSFindIssue")) {
          response.end(JSON.stringify({ data: { issues: { nodes: [linearIssueNode("AG-1", "In Progress")] } } }));
          return;
        }
        if (payload.query.includes("AgentOSStates")) {
          response.end(JSON.stringify({ data: { workflowStates: { nodes: [{ id: "state-review", name: "Human Review" }] } } }));
          return;
        }
        if (payload.query.includes("AgentOSIssueMove")) {
          movedInput = payload.variables?.input;
          response.end(JSON.stringify({ data: { issueUpdate: { success: true } } }));
          return;
        }
        response.end(JSON.stringify({ data: {} }));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as { port: number }).port;
    await writeAgentOwnedWorkflow(repo, `http://127.0.0.1:${port}/graphql`);

    try {
      const result = await execOk(process.execPath, [
        "--import",
        "tsx",
        cliScript,
        "linear",
        "lifecycle",
        "move",
        "AG-1",
        "Human Review",
        "--run-id",
        "run-123",
        "--attempt",
        "0",
        "--repo",
        repo,
        "--workflow",
        "WORKFLOW.md",
        "--tool",
        "scripts/agent-linear-move.sh"
      ]);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      expect(parsed).toEqual({
        schemaVersion: 1,
        status: "moved",
        issueIdentifier: "AG-1",
        marker: "<!-- agentos:event=state_transition issue=AG-1 run=run-123 attempt=0 -->",
        runId: "run-123",
        attempt: 0
      });
      expect(movedInput).toEqual({ stateId: "state-review" });
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("verifies handoff validation evidence before posting agent-owned handoff JSON", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "agent-os-lifecycle-handoff-json-cli-")));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    const handoffPath = join(repo, ".agent-os", "handoff-AG-1.md");
    await writeFile(
      handoffPath,
      "AgentOS-Outcome: implemented\n\nValidation-JSON: .agent-os/validation/AG-1.json\n",
      "utf8"
    );
    let createdBody = "";
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        const payload = JSON.parse(raw) as { query: string; variables?: Record<string, any> };
        response.writeHead(200, { "content-type": "application/json" });
        if (payload.query.includes("AgentOSFindIssue")) {
          response.end(JSON.stringify({ data: { issues: { nodes: [linearIssueNode("AG-1")] } } }));
          return;
        }
        if (payload.query.includes("AgentOSIssueComments")) {
          response.end(JSON.stringify({ data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
          return;
        }
        if (payload.query.includes("AgentOSComment")) {
          createdBody = String(payload.variables?.input?.body ?? "");
          response.end(JSON.stringify({ data: { commentCreate: { success: true } } }));
          return;
        }
        response.end(JSON.stringify({ data: {} }));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as { port: number }).port;
    await writeAgentOwnedWorkflow(repo, `http://127.0.0.1:${port}/graphql`);
    await writeCliValidationEvidence(repo, "AG-1", "run-123");

    try {
      const result = await execOk(process.execPath, [
        "--import",
        "tsx",
        cliScript,
        "linear",
        "lifecycle",
        "record-handoff",
        "AG-1",
        "--file",
        ".agent-os/handoff-AG-1.md",
        "--run-id",
        "run-123",
        "--attempt",
        "0",
        "--repo",
        repo,
        "--workflow",
        "WORKFLOW.md",
        "--tool",
        "scripts/agent-linear-handoff.sh"
      ]);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      expect(parsed).toEqual({
        schemaVersion: 1,
        status: "created",
        issueIdentifier: "AG-1",
        marker: "<!-- agentos:event=run_handoff issue=AG-1 run=run-123 attempt=0 -->",
        runId: "run-123",
        attempt: 0
      });
      expect(createdBody).toContain("<!-- agentos:event=run_handoff issue=AG-1 run=run-123 attempt=0 -->");
      expect(createdBody).toContain("Validation-JSON: .agent-os/validation/AG-1.json");
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("rejects agent-owned lifecycle CLI writes without run correlation before tracker writes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-correlation-cli-"));
    await writeAgentOwnedWorkflow(repo, "http://127.0.0.1:9/graphql");

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

    expect(result.stderr).toContain("lifecycle.mode=agent-owned requires --run-id");
  });

  it("rejects lifecycle workflow paths that are absolute or escape the repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-lifecycle-workflow-"));
    const outside = join(await mkdtemp(join(tmpdir(), "agent-os-lifecycle-outside-")), "WORKFLOW.md");
    await writeWorkflow(repo);
    await writeFile(outside, "---\nlifecycle:\n  mode: agent-owned\ntracker:\n  kind: linear\n  api_key: lin_test\n  project_slug: AgentOS\n---\nDo work", "utf8");

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

async function writeCliValidationEvidence(repo: string, issueIdentifier: string, runId: string): Promise<void> {
  const workflow = await loadWorkflow(join(repo, "WORKFLOW.md"));
  const config = resolveServiceConfig(workflow, { ...process.env, LINEAR_API_KEY: "lin_test" });
  const now = new Date().toISOString();
  await writeValidationEvidence(join(repo, ".agent-os", "validation", `${issueIdentifier}.json`), {
    schemaVersion: 1,
    issueIdentifier,
    runId,
    status: "passed",
    commands: [
      {
        name: config.validationBudget.fullValidationCommand,
        exitCode: 0,
        startedAt: now,
        finishedAt: now
      }
    ],
    reuseProfile: validationReuseProfileForConfig(config)
  });
}

async function writeWorkflow(repo: string, allowedTrackerTools = ["scripts/agent-linear-comment.sh"]): Promise<void> {
  await writeFile(
    join(repo, "WORKFLOW.md"),
    [
      "---",
      "lifecycle:",
      "  mode: agent-owned",
      ...(allowedTrackerTools.length > 0 ? ["  allowed_tracker_tools:", ...allowedTrackerTools.map((tool) => `    - ${tool}`)] : []),
      "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
      "  allowed_state_transitions:",
      "    - Todo -> In Progress",
      "    - In Progress -> Human Review",
      "  duplicate_comment_behavior: upsert",
      "  fallback_behavior: write handoff and stop human_required",
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

async function writeAgentOwnedWorkflow(repo: string, endpoint: string): Promise<void> {
  await writeFile(
    join(repo, "WORKFLOW.md"),
    [
      "---",
      "lifecycle:",
      "  mode: agent-owned",
      "  allowed_tracker_tools:",
      "    - scripts/agent-linear-comment.sh",
      "    - scripts/agent-linear-move.sh",
      "    - scripts/agent-linear-pr.sh",
      "    - scripts/agent-linear-handoff.sh",
      "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
      "  allowed_state_transitions:",
      "    - Todo -> In Progress",
      "    - In Progress -> Human Review",
      "  duplicate_comment_behavior: upsert",
      "  fallback_behavior: write handoff and stop human_required",
      "tracker:",
      "  kind: linear",
      `  endpoint: ${endpoint}`,
      "  api_key: lin_test",
      "  project_slug: AgentOS",
      "---",
      "Do work"
    ].join("\n"),
    "utf8"
  );
}

async function writeSupervisorWorkflow(repo: string, endpoint: string): Promise<void> {
  await writeFile(
    join(repo, "WORKFLOW.md"),
    [
      "---",
      "lifecycle:",
      "  mode: agent-owned",
      "  allowed_tracker_tools:",
      "    - scripts/agent-linear-comment.sh",
      "    - scripts/agent-linear-move.sh",
      "    - scripts/agent-linear-pr.sh",
      "    - scripts/agent-linear-handoff.sh",
      "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
      "  allowed_state_transitions:",
      "    - Todo -> In Progress",
      "    - In Progress -> Human Review",
      "    - Human Review -> Merging",
      "  duplicate_comment_behavior: upsert",
      "  fallback_behavior: write handoff and stop human_required",
      "tracker:",
      "  kind: linear",
      `  endpoint: ${endpoint}`,
      "  api_key: lin_test",
      "  project_slug: AgentOS",
      "  active_states:",
      "    - Todo",
      "    - In Progress",
      "  terminal_states:",
      "    - Done",
      "    - Closed",
      "    - Canceled",
      "    - Duplicate",
      "  running_state: In Progress",
      "  review_state: Human Review",
      "  merge_state: Merging",
      "  needs_input_state: Human Review",
      "github:",
      "  done_state: Done",
      "---",
      "Do work"
    ].join("\n"),
    "utf8"
  );
}

function linearIssueNode(identifier: string, state = "Human Review"): Record<string, unknown> {
  return {
    id: "issue-1",
    identifier,
    title: "Issue",
    url: `https://linear.test/${identifier}`,
    state: { name: state },
    team: { id: "team-1", key: "AG", name: "AgentOS" },
    assignee: null,
    project: { id: "project-1", name: "AgentOS", slugId: "AgentOS" }
  };
}
