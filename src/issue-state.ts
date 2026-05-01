import { join } from "node:path";
import { ensureDir, exists, readText, writeTextEnsuringDir } from "./fs-utils.js";
import type { Issue, IssueState, PullRequestRef } from "./types.js";

type IssueOutcome = NonNullable<IssueState["outcome"]>;
export const ISSUE_STATE_SCHEMA_VERSION = 1;

export class IssueStateStore {
  constructor(private readonly repoRoot: string) {}

  async read(identifier: string): Promise<IssueState | null> {
    const path = this.pathFor(identifier);
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readText(path)) as Partial<IssueState>;
    return parsed.issueIdentifier ? normalizeIssueState(parsed) : null;
  }

  async write(state: IssueState): Promise<void> {
    const normalized = normalizeIssueState(state);
    await ensureDir(join(this.repoRoot, ".agent-os", "state", "issues"));
    await writeTextEnsuringDir(this.pathFor(normalized.issueIdentifier), `${JSON.stringify(normalized, null, 2)}\n`);
  }

  async merge(identifier: string, patch: Partial<IssueState> & Pick<IssueState, "issueId" | "issueIdentifier">): Promise<IssueState> {
    const current = await this.read(identifier);
    const patchState = normalizeIssueState({
      ...patch,
      issueId: patch.issueId,
      issueIdentifier: patch.issueIdentifier,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    });
    const next = normalizeIssueState({
      ...(current ?? { schemaVersion: ISSUE_STATE_SCHEMA_VERSION, issueId: patch.issueId, issueIdentifier: patch.issueIdentifier, updatedAt: new Date().toISOString() }),
      ...patchState,
      prs: mergePullRequestRefs(current?.prs ?? [], patchState.prs ?? []),
      updatedAt: new Date().toISOString()
    });
    await this.write(next);
    return next;
  }

  private pathFor(identifier: string): string {
    return join(this.repoRoot, ".agent-os", "state", "issues", `${safeFileName(identifier)}.json`);
  }
}

export function issueStateFromHandoff(issue: Issue, handoff: string): IssueState | null {
  const prUrls = extractPullRequestUrls(handoff);
  const outcome = extractOutcome(handoff);
  if (prUrls.length === 0 && !outcome) return null;
  const updatedAt = new Date().toISOString();
  const prs = prUrls.map((url) => ({ url, discoveredAt: updatedAt, source: "handoff" as const }));
  return {
    schemaVersion: ISSUE_STATE_SCHEMA_VERSION,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    ...(prs.length ? { prs, prUrl: prs[0].url } : {}),
    ...(outcome ? { outcome } : {}),
    ...(prs.length ? { reviewStatus: "pending" as const, reviewIteration: 0 } : {}),
    updatedAt
  };
}

export function extractPullRequestUrl(text: string): string | null {
  return extractPullRequestUrls(text)[0] ?? null;
}

export function extractPullRequestUrls(text: string): string[] {
  const matches = text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g);
  return [...new Set([...matches].map((match) => match[0]))];
}

export function primaryPullRequestUrl(state: Pick<IssueState, "prs" | "prUrl"> | null | undefined): string | null {
  return state?.prs?.[0]?.url ?? state?.prUrl ?? null;
}

export function pullRequestUrls(state: Pick<IssueState, "prs" | "prUrl"> | null | undefined): string[] {
  const urls = [...(state?.prs ?? []).map((pr) => pr.url)];
  if (state?.prUrl) urls.push(state.prUrl);
  return [...new Set(urls)];
}

export function normalizeIssueState(raw: Partial<IssueState>): IssueState {
  const updatedAt = raw.updatedAt ?? new Date().toISOString();
  const legacyPr = raw.prUrl ? [{ url: raw.prUrl, discoveredAt: updatedAt, source: "legacy" as const }] : [];
  const prs = mergePullRequestRefs(raw.prs ?? [], legacyPr);
  return {
    ...raw,
    schemaVersion: ISSUE_STATE_SCHEMA_VERSION,
    issueId: raw.issueId ?? "",
    issueIdentifier: raw.issueIdentifier ?? "",
    ...(prs.length ? { prs, prUrl: prs[0].url } : { prs: undefined, prUrl: undefined }),
    updatedAt
  };
}

export function mergePullRequestRefs(existing: PullRequestRef[], incoming: PullRequestRef[]): PullRequestRef[] {
  const byUrl = new Map<string, PullRequestRef>();
  for (const item of [...existing, ...incoming]) {
    if (!item.url) continue;
    if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
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
