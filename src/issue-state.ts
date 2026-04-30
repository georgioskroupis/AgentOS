import { join } from "node:path";
import { ensureDir, exists, readText, writeTextEnsuringDir } from "./fs-utils.js";
import type { Issue, IssueState } from "./types.js";

type IssueOutcome = NonNullable<IssueState["outcome"]>;

export class IssueStateStore {
  constructor(private readonly repoRoot: string) {}

  async read(identifier: string): Promise<IssueState | null> {
    const path = this.pathFor(identifier);
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readText(path)) as IssueState;
    return parsed.issueIdentifier ? parsed : null;
  }

  async write(state: IssueState): Promise<void> {
    await ensureDir(join(this.repoRoot, ".agent-os", "state", "issues"));
    await writeTextEnsuringDir(this.pathFor(state.issueIdentifier), `${JSON.stringify(state, null, 2)}\n`);
  }

  async merge(identifier: string, patch: Partial<IssueState> & Pick<IssueState, "issueId" | "issueIdentifier">): Promise<IssueState> {
    const current = await this.read(identifier);
    const next: IssueState = {
      ...(current ?? { issueId: patch.issueId, issueIdentifier: patch.issueIdentifier, updatedAt: new Date().toISOString() }),
      ...patch,
      updatedAt: new Date().toISOString()
    };
    await this.write(next);
    return next;
  }

  private pathFor(identifier: string): string {
    return join(this.repoRoot, ".agent-os", "state", "issues", `${safeFileName(identifier)}.json`);
  }
}

export function issueStateFromHandoff(issue: Issue, handoff: string): IssueState | null {
  const prUrl = extractPullRequestUrl(handoff);
  const outcome = extractOutcome(handoff);
  if (!prUrl && !outcome) return null;
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    ...(prUrl ? { prUrl } : {}),
    ...(outcome ? { outcome } : {}),
    ...(prUrl ? { reviewStatus: "pending" as const, reviewIteration: 0 } : {}),
    updatedAt: new Date().toISOString()
  };
}

export function extractPullRequestUrl(text: string): string | null {
  const match = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/);
  return match?.[0] ?? null;
}

export function extractOutcome(text: string): IssueOutcome | null {
  const match = text.match(/^AgentOS-Outcome:\s*(.+)$/im);
  if (!match) return null;
  const normalized = match[1].trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["already-satisfied", "already-done", "no-op", "noop"].includes(normalized)) return "already_satisfied";
  if (["partially-satisfied", "partial", "partial-implementation"].includes(normalized)) return "partially_satisfied";
  if (["implemented", "changed", "completed"].includes(normalized)) return "implemented";
  return null;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
