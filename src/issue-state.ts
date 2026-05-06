import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, exists, readText, writeTextEnsuringDir } from "./fs-utils.js";
import type { AppProofState, HumanDecisionState, HumanDecisionType, Issue, IssueComment, IssueState, PullRequestRef, PullRequestRole, ReviewTargetMode } from "./types.js";

type IssueOutcome = NonNullable<IssueState["outcome"]>;
export const ISSUE_STATE_SCHEMA_VERSION = 1;
export const MERGE_ELIGIBLE_PR_ROLES: PullRequestRole[] = ["primary", "docs"];

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

  async list(): Promise<IssueState[]> {
    const root = join(this.repoRoot, ".agent-os", "state", "issues");
    if (!(await exists(root))) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const states: IssueState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = JSON.parse(await readText(join(root, entry.name))) as Partial<IssueState>;
      if (parsed.issueIdentifier) states.push(normalizeIssueState(parsed));
    }
    return states.sort((a, b) => a.issueIdentifier.localeCompare(b.issueIdentifier));
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
      humanDecisions: mergeHumanDecisions(current?.humanDecisions ?? [], patchState.humanDecisions ?? []),
      appProof: mergeAppProof(current?.appProof, patchState.appProof),
      updatedAt: new Date().toISOString()
    });
    await this.write(next);
    return next;
  }

  private pathFor(identifier: string): string {
    return join(this.repoRoot, ".agent-os", "state", "issues", `${safeFileName(identifier)}.json`);
  }
}

interface HumanDecisionTrustOptions {
  trustedActors?: string[];
  issueAssignee?: string | null;
}

export function issueStateFromHandoff(issue: Issue, handoff: string): IssueState | null {
  const prs = extractPullRequestRefs(handoff);
  const outcome = extractOutcome(handoff);
  const appProof = extractAppProof(handoff);
  const humanDecision = extractHumanDecision(handoff, { source: "handoff" });
  if (prs.length === 0 && !outcome && !appProof && !humanDecision) return null;
  const updatedAt = new Date().toISOString();
  const discovered = prs.map((pr) => ({ ...pr, discoveredAt: updatedAt, source: "handoff" as const }));
  return {
    schemaVersion: ISSUE_STATE_SCHEMA_VERSION,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    ...(discovered.length ? { prs: discovered, prUrl: discovered[0].url } : {}),
    ...(outcome ? { outcome } : {}),
    ...(appProof ? { appProof } : {}),
    ...(humanDecision ? { humanDecisions: [humanDecision], lastHumanDecision: humanDecision } : {}),
    ...(discovered.length ? { reviewStatus: "pending" as const, reviewIteration: 0 } : {}),
    updatedAt
  };
}

export function extractPullRequestUrl(text: string): string | null {
  return extractPullRequestUrls(text)[0] ?? null;
}

export function extractPullRequestUrls(text: string): string[] {
  return extractPullRequestRefs(text).map((pr) => pr.url);
}

export function extractPullRequestRefs(text: string): Array<Omit<PullRequestRef, "discoveredAt" | "source">> {
  const byUrl = new Map<string, { url: string; role: PullRequestRole | null }>();
  for (const line of text.split(/\r?\n/)) {
    const matches = line.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g);
    for (const match of matches) {
      const url = match[0];
      const role = inferPullRequestRole(line);
      const existing = byUrl.get(url);
      if (!existing) {
        byUrl.set(url, { url, role });
      } else if (role) {
        existing.role = role;
      }
    }
  }
  return assignDefaultPullRequestRoles([...byUrl.values()].map((item) => ({ url: item.url, ...(item.role ? { role: item.role } : {}) })));
}

export function primaryPullRequestUrl(state: Pick<IssueState, "prs" | "prUrl"> | null | undefined): string | null {
  return primaryPullRequestRef(state)?.url ?? null;
}

export function primaryPullRequestRef(state: Pick<IssueState, "prs" | "prUrl"> | null | undefined): PullRequestRef | null {
  const prs = normalizePullRequestRefs(state?.prs ?? [], state?.prUrl);
  return prs.find((pr) => pr.role === "primary") ?? prs[0] ?? null;
}

export function pullRequestUrls(state: Pick<IssueState, "prs" | "prUrl"> | null | undefined): string[] {
  return normalizePullRequestRefs(state?.prs ?? [], state?.prUrl).map((pr) => pr.url);
}

export function reviewTargetPullRequests(
  state: Pick<IssueState, "prs" | "prUrl"> | null | undefined,
  mode: ReviewTargetMode = "merge-eligible"
): PullRequestRef[] {
  const prs = normalizePullRequestRefs(state?.prs ?? [], state?.prUrl);
  if (mode === "primary") {
    const primary = prs.filter((pr) => pr.role === "primary");
    return primary.length === 1 ? primary : [];
  }
  return prs.filter(isMergeEligiblePullRequest);
}

export function mergeTargetPullRequest(state: Pick<IssueState, "prs" | "prUrl"> | null | undefined): PullRequestRef | null {
  const prs = normalizePullRequestRefs(state?.prs ?? [], state?.prUrl);
  const primary = prs.filter((pr) => pr.role === "primary");
  if (primary.length === 1 && isMergeEligiblePullRequest(primary[0])) return primary[0];
  if (primary.length > 1) return null;
  const eligible = prs.filter(isMergeEligiblePullRequest);
  return eligible.length === 1 ? eligible[0] : null;
}

export function mergeEligiblePullRequests(state: Pick<IssueState, "prs" | "prUrl"> | null | undefined): PullRequestRef[] {
  return normalizePullRequestRefs(state?.prs ?? [], state?.prUrl).filter(isMergeEligiblePullRequest);
}

export function mergeTargetAmbiguityReason(state: Pick<IssueState, "prs" | "prUrl"> | null | undefined): string | null {
  const prs = normalizePullRequestRefs(state?.prs ?? [], state?.prUrl);
  const primary = prs.filter((pr) => pr.role === "primary");
  if (primary.length > 1) {
    return `Multiple primary pull requests were recorded; select exactly one primary PR before merging. ${formatPullRequestRefs(primary)}`;
  }
  const eligible = prs.filter(isMergeEligiblePullRequest);
  if (primary.length === 0 && eligible.length > 1) {
    return `Multiple merge-eligible pull requests were recorded without a primary PR; select exactly one primary PR before merging. ${formatPullRequestRefs(eligible)}`;
  }
  return null;
}

export function isMergeEligiblePullRequest(pr: Pick<PullRequestRef, "role">): boolean {
  return MERGE_ELIGIBLE_PR_ROLES.includes(pr.role ?? "supporting");
}

export function normalizeIssueState(raw: Partial<IssueState>): IssueState {
  const updatedAt = raw.updatedAt ?? new Date().toISOString();
  const prs = normalizePullRequestRefs(raw.prs ?? [], raw.prUrl, updatedAt);
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
    const current = byUrl.get(item.url);
    if (!current) {
      byUrl.set(item.url, item);
    } else if (item.role) {
      byUrl.set(item.url, { ...current, ...item, role: item.role });
    }
  }
  return assignDefaultPullRequestRoles([...byUrl.values()]);
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

export function extractAppProof(text: string): AppProofState | null {
  const artifacts: AppProofState["artifacts"] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(App-Proof|Proof-Artifact):\s*(.+)$/i);
    if (!match) continue;
    const value = match[2].trim();
    if (!value) continue;
    artifacts.push({
      label: match[1].toLowerCase() === "app-proof" ? "app-proof" : "proof-artifact",
      value,
      source: "handoff" as const
    });
  }
  return artifacts.length ? { updatedAt: new Date().toISOString(), artifacts } : null;
}

export function extractHumanDecision(
  text: string,
  metadata: {
    source: HumanDecisionState["source"];
    actor?: string | null;
    commentId?: string;
    createdAt?: string | null;
  }
): HumanDecisionState | null {
  const fields = decisionFields(text);
  const rawType = fields.get("agentos-human-decision") ?? fields.get("human-decision") ?? fields.get("decision-type");
  const type = normalizeHumanDecisionType(rawType);
  if (!type) return null;
  const decidedAt = metadata.createdAt && !Number.isNaN(Date.parse(metadata.createdAt)) ? metadata.createdAt : new Date().toISOString();
  return {
    type,
    decidedAt,
    source: metadata.source,
    ...(metadata.actor !== undefined ? { actor: metadata.actor } : {}),
    ...(metadata.commentId ? { commentId: metadata.commentId } : {}),
    body: text.trim().slice(0, 2000),
    prHeadSha: fields.get("pr-head-sha") ?? fields.get("head-sha") ?? null,
    validationEvidence: fields.get("validation-json") ?? fields.get("validation-evidence") ?? null,
    ciState: normalizeCiState(fields.get("ci-state") ?? fields.get("ci")),
    findings: normalizeFindingsState(fields.get("findings") ?? fields.get("finding-state")),
    summary: fields.get("decision-summary") ?? fields.get("summary") ?? undefined
  };
}

export function extractHumanDecisionsFromComments(comments: IssueComment[], options: HumanDecisionTrustOptions = {}): HumanDecisionState[] {
  return comments
    .map((comment) =>
      extractHumanDecision(comment.body, {
        source: "linear-comment",
        actor: comment.author,
        commentId: comment.id,
        createdAt: comment.createdAt ?? comment.updatedAt
      })
    )
    .filter((decision): decision is HumanDecisionState => Boolean(decision))
    .filter((decision) => isTrustedHumanDecisionActor(decision.actor, options))
    .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
}

export function isTrustedHumanDecisionActor(actor: string | null | undefined, options: HumanDecisionTrustOptions = {}): boolean {
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor) return false;
  const trusted = [...(options.trustedActors ?? []), options.issueAssignee ?? ""]
    .map(normalizeActor)
    .filter((value): value is string => Boolean(value));
  return trusted.includes(normalizedActor);
}

export function latestHumanDecision(decisions: HumanDecisionState[] | undefined): HumanDecisionState | null {
  if (!decisions?.length) return null;
  const sorted = [...decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  return sorted[sorted.length - 1] ?? null;
}

function normalizePullRequestRefs(existing: PullRequestRef[], legacyUrl?: string | null, updatedAt = new Date().toISOString()): PullRequestRef[] {
  const legacy = legacyUrl ? [{ url: legacyUrl, discoveredAt: updatedAt, source: "legacy" as const }] : [];
  return mergePullRequestRefs(existing, legacy);
}

function mergeHumanDecisions(existing: HumanDecisionState[], incoming: HumanDecisionState[]): HumanDecisionState[] | undefined {
  const byKey = new Map<string, HumanDecisionState>();
  for (const decision of [...existing, ...incoming]) {
    byKey.set(humanDecisionKey(decision), decision);
  }
  const merged = [...byKey.values()].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  return merged.length ? merged : undefined;
}

function humanDecisionKey(decision: HumanDecisionState): string {
  return decision.commentId ? `comment:${decision.commentId}` : `${decision.source}:${decision.decidedAt}:${decision.type}:${decision.body ?? ""}`;
}

function mergeAppProof(existing: AppProofState | undefined, incoming: AppProofState | undefined): AppProofState | undefined {
  const artifacts = [...(existing?.artifacts ?? []), ...(incoming?.artifacts ?? [])];
  const byValue = new Map<string, AppProofState["artifacts"][number]>();
  for (const artifact of artifacts) byValue.set(`${artifact.label}:${artifact.value}`, artifact);
  if (byValue.size === 0) return undefined;
  return {
    updatedAt: incoming?.updatedAt ?? existing?.updatedAt ?? new Date().toISOString(),
    artifacts: [...byValue.values()]
  };
}

function decisionFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 -]*):\s*(.+)$/);
    if (!match) continue;
    fields.set(match[1].trim().toLowerCase().replace(/\s+/g, "-"), match[2].trim());
  }
  return fields;
}

function normalizeHumanDecisionType(value: string | null | undefined): HumanDecisionType | null {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (["approve", "approved", "approve_as_is", "approve_as_is_no_change"].includes(normalized)) return "approve_as_is";
  if (["fix", "fix_findings", "changes_requested", "address_feedback"].includes(normalized)) return "fix_findings";
  if (["accept_risk", "risk_accepted", "accepted_risk"].includes(normalized)) return "accept_risk";
  if (["split_follow_up", "split_followup", "follow_up", "followup"].includes(normalized)) return "split_follow_up";
  if (["proceed_to_merge_after_supervisor_fix", "merge_after_supervisor_fix", "supervisor_fixed", "externally_fixed"].includes(normalized)) {
    return "proceed_to_merge_after_supervisor_fix";
  }
  return null;
}

function normalizeCiState(value: string | null | undefined): HumanDecisionState["ciState"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "passed" || normalized === "failed" || normalized === "pending") return normalized;
  return value ? "unknown" : null;
}

function normalizeFindingsState(value: string | null | undefined): HumanDecisionState["findings"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "resolved" || normalized === "accepted" || normalized === "open") return normalized;
  return value ? "unknown" : undefined;
}

function normalizeActor(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? normalized : null;
}

function assignDefaultPullRequestRoles<T extends { url: string; role?: PullRequestRole }>(refs: T[]): Array<T & { role: PullRequestRole }> {
  const hasExplicitPrimary = refs.some((ref) => ref.role === "primary");
  let primaryAssigned = hasExplicitPrimary;
  return refs.map((ref) => {
    if (ref.role) return { ...ref, role: ref.role };
    if (!primaryAssigned) {
      primaryAssigned = true;
      return { ...ref, role: "primary" as const };
    }
    return { ...ref, role: "supporting" as const };
  });
}

function inferPullRequestRole(line: string): PullRequestRole | null {
  const normalized = line.toLowerCase().replace(/[_\s]+/g, "-");
  if (/do-?not-?merge|do-not-merge|no-merge|blocked-from-merge/.test(normalized)) return "do-not-merge";
  if (/follow-?up/.test(normalized)) return "follow-up";
  if (/\bdocs?\b/.test(normalized)) return "docs";
  if (/supporting|related|reference|review-only/.test(normalized)) return "supporting";
  if (/primary|merge-eligible|merge-target/.test(normalized)) return "primary";
  return null;
}

function formatPullRequestRefs(refs: PullRequestRef[]): string {
  return refs.map((ref) => `${ref.url} (${ref.role ?? "supporting"})`).join(", ");
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
