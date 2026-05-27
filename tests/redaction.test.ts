import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLogger } from "../src/logging.js";
import { Orchestrator } from "../src/orchestrator.js";
import { redactText, redactValue } from "../src/redaction.js";
import { fakeIssue, FakeRunner, FakeTracker, strictAgentOwnedLifecycleYaml, writePassingHandoff } from "./fixtures/agentos-fakes.js";

describe("redaction", () => {
  it("redacts token-shaped values and sensitive env values", () => {
    const openAiKey = `sk-${"abcdefghijklmnopqrstuvwxyz"}`;
    const githubToken = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const text = redactText(
      `token ${openAiKey} and env super-secret-value`,
      { AGENTOS_TEST_TOKEN: "super-secret-value" }
    );

    expect(text).toBe("token [REDACTED] and env [REDACTED]");
    expect(redactValue({ nested: [githubToken] })).toEqual({ nested: ["[REDACTED]"] });
  });

  it("redacts events before they are persisted", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-redaction-log-"));
    const logger = new JsonlLogger(repo);

    await logger.write({
      type: "secret_event",
      message: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      payload: { token: `lin_${"abcdefghijklmnopqrstuvwxyz123456"}` }
    });

    const log = await readFile(join(repo, ".agent-os", "runs", "agent-os.jsonl"), "utf8");
    expect(log).toContain("[REDACTED]");
    expect(log).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("bounds repeated runner stderr and links a redacted artifact", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-bounded-log-"));
    const logger = new JsonlLogger(repo);
    const secret = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const warning = `Plugin manifest warning Authorization: Bearer ${secret}`;
    const repeated = Array.from({ length: 80 }, () => warning).join("\n");

    await logger.write({
      runId: "run_20260501000000_AG-1_large",
      type: "review_codex_stderr",
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      message: repeated
    });

    const log = await readFile(join(repo, ".agent-os", "runs", "agent-os.jsonl"), "utf8");
    const entry = JSON.parse(log.trim()) as { message: string };
    const artifact = entry.message.match(/full redacted artifact: ([^\]]+)/)?.[1];

    expect(log.trim().length).toBeLessThan(5_000);
    expect(entry.message).toContain("repeated 80x");
    expect(entry.message).toContain("duplicate line(s) summarized");
    expect(entry.message).toContain("full redacted artifact");
    expect(log).not.toContain(secret);
    expect(artifact).toBeTruthy();

    const artifactText = await readFile(join(repo, artifact!), "utf8");
    expect(artifactText).toContain("[REDACTED]");
    expect(artifactText).not.toContain(secret);
    expect(artifactText.match(/Plugin manifest warning/g)).toHaveLength(80);
  });

  it("redacts lifecycle comments before sending them to Linear", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-redaction-comment-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        strictAgentOwnedLifecycleYaml,
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "  active_states: [Ready]",
        "workspace:",
        "  root: .agent-os/workspaces",
        "review:",
        "  enabled: false",
        "---",
        "Do {{ issue.identifier }}"
      ].join("\n"),
      "utf8"
    );
    const issue = fakeIssue();
    const tracker = new FakeTracker([issue], new Map([[issue.id, issue]]));
    const runner = new FakeRunner(async (workspace, input) => {
      const openAiKey = `sk-${"abcdefghijklmnopqrstuvwxyz"}`;
      await writePassingHandoff(workspace, "AG-1", input.prompt, `AgentOS-Outcome: already-satisfied\n\nSecret: ${openAiKey}`);
      return { status: "succeeded" };
    });

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const comments = tracker.comments.map((comment) => comment.body).join("\n");
    expect(comments).toContain("[REDACTED]");
    expect(comments).not.toContain("sk-");
  });
});
