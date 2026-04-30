import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLogger } from "../src/logging.js";
import { Orchestrator } from "../src/orchestrator.js";
import { redactText, redactValue } from "../src/redaction.js";
import { fakeIssue, FakeRunner, FakeTracker } from "./fixtures/agentos-fakes.js";

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

  it("redacts lifecycle comments before sending them to Linear", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-redaction-comment-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const issue = fakeIssue();
    const tracker = new FakeTracker([issue], new Map([[issue.id, issue]]));
    const runner = new FakeRunner(async (workspace) => {
      const openAiKey = `sk-${"abcdefghijklmnopqrstuvwxyz"}`;
      await mkdir(join(workspace.path, ".agent-os"), { recursive: true });
      await writeFile(
        join(workspace.path, ".agent-os", "handoff-AG-1.md"),
        `AgentOS-Outcome: already-satisfied\n\nSecret: ${openAiKey}`,
        "utf8"
      );
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
