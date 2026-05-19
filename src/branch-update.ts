import { evaluateLandingPolicyForConfig } from "./landing-policy.js";
import type { PullRequestStatus } from "./github.js";
import type { ServiceConfig } from "./types.js";

export type BranchFreshnessAction = "none" | "update" | "report-only";

export interface BranchFreshnessPlan {
  action: BranchFreshnessAction;
  reason: string;
  operatorGuidance: string;
  mergeStateStatus: string | null;
}

export function planBranchFreshnessUpdate(config: ServiceConfig, status: PullRequestStatus): BranchFreshnessPlan {
  const mergeState = normalizeMergeStateStatus(status.mergeStateStatus);
  const reportOnlyCheck = reportOnlyCheckRequirement(status);
  if (reportOnlyCheck) return reportOnlyCheck;
  if (status.mergeable?.toUpperCase() === "CONFLICTING" || mergeState === "DIRTY") {
    return reportOnly(
      mergeState,
      "The pull request has merge conflicts.",
      "Report only: resolve the merge conflict outside AgentOS' bounded branch update path."
    );
  }
  if (mergeState === "BLOCKED" || mergeState === "HAS_HOOKS") {
    return reportOnly(
      mergeState,
      "The pull request is blocked by branch protection, required checks, hooks, or merge queue policy.",
      "Report only: satisfy the protected branch or merge queue requirement outside AgentOS until explicit support is added."
    );
  }
  if (mergeState === "UNKNOWN") {
    return reportOnly(
      mergeState,
      "GitHub could not determine whether the pull request branch is safely updateable.",
      "Report only: refresh PR metadata or inspect GitHub before attempting an automated branch update."
    );
  }
  if (mergeState !== "BEHIND") {
    return {
      action: "none",
      reason: "The pull request branch is not reported as stale.",
      operatorGuidance: "No branch freshness action is needed.",
      mergeStateStatus: mergeState
    };
  }

  const policy = evaluateLandingPolicyForConfig(config);
  if (!policy.enabled) {
    return reportOnly(
      mergeState,
      `The pull request branch is stale, but high-throughput landing is not enabled (${policy.reasons.join("; ")}).`,
      "Report only: enable the explicit high-throughput landing policy before AgentOS updates PR branches."
    );
  }
  const safety = safeHeadBranch(status);
  if (!safety.safe) {
    return reportOnly(mergeState, `The pull request branch is stale, but AgentOS cannot update it safely: ${safety.reason}.`, "Report only: update the branch manually or adjust the PR to an AgentOS-managed same-repository branch.");
  }
  return {
    action: "update",
    reason: "The pull request branch is stale and eligible for a bounded same-repository update.",
    operatorGuidance: "Run one safe branch update, then refresh PR head, checks, and validation freshness before merge progression.",
    mergeStateStatus: mergeState
  };
}

export function branchFreshnessCommentBody(prUrl: string, status: PullRequestStatus, plan: BranchFreshnessPlan): string {
  return [
    "### AgentOS branch freshness",
    "",
    plan.action === "update"
      ? "AgentOS updated the stale pull request branch using the bounded high-throughput branch freshness path."
      : "AgentOS did not update the pull request branch.",
    "",
    `- PR: ${prUrl}`,
    status.headSha ? `- Head before refresh: ${status.headSha}` : null,
    status.headRefName ? `- Branch: ${status.headRefName}` : null,
    plan.mergeStateStatus ? `- GitHub merge state: ${plan.mergeStateStatus}` : null,
    `- Decision: ${plan.action}`,
    `- Reason: ${plan.reason}`,
    `- Next: ${plan.operatorGuidance}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function reportOnly(mergeStateStatus: string | null, reason: string, operatorGuidance: string): BranchFreshnessPlan {
  return { action: "report-only", reason, operatorGuidance, mergeStateStatus };
}

function reportOnlyCheckRequirement(status: PullRequestStatus): BranchFreshnessPlan | null {
  const text = status.checkDetails.map((check) => `${check.name} ${check.status ?? ""} ${check.conclusion ?? ""} ${check.state ?? ""} ${check.url ?? ""}`).join("\n");
  if (!/protected branch|required status checks?|merge queue|merge_group|merge train|bors/i.test(text)) return null;
  return reportOnly(
    normalizeMergeStateStatus(status.mergeStateStatus),
    "The pull request checks mention protected branch or merge queue requirements.",
    "Report only: satisfy the protected branch or merge queue requirement outside AgentOS until explicit support is added."
  );
}

function safeHeadBranch(status: PullRequestStatus): { safe: true } | { safe: false; reason: string } {
  if (status.state && status.state.toUpperCase() !== "OPEN") return { safe: false, reason: `pull request is ${status.state}` };
  if (status.isDraft) return { safe: false, reason: "pull request is still a draft" };
  if (status.isCrossRepository !== false) return { safe: false, reason: "pull request head repository is external or unavailable" };
  if (!status.headRepository) return { safe: false, reason: "pull request head repository is unavailable" };
  if (!status.headRefName) return { safe: false, reason: "pull request head branch is unavailable" };
  if (status.baseRefName && status.headRefName === status.baseRefName) return { safe: false, reason: "head branch matches the base branch" };
  if (!/^agent\/[A-Za-z0-9._/-]+$/.test(status.headRefName)) return { safe: false, reason: "only AgentOS-managed agent/* branches are updated automatically" };
  if (status.headRefName.includes("..") || status.headRefName.includes("//") || status.headRefName.endsWith("/") || status.headRefName.startsWith("-")) {
    return { safe: false, reason: "head branch name is not a safe branch ref" };
  }
  return { safe: true };
}

function normalizeMergeStateStatus(value: string | null | undefined): string | null {
  return value ? value.toUpperCase() : null;
}
