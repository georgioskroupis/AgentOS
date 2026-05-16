import type { PreDispatchScopeReport, ScopeEvidence, ScopeImplementationStatus, ScopeSize } from "./scope-report.js";

export function buildDispatchAdvice(
  implementationStatus: ScopeImplementationStatus,
  scopeSize: ScopeSize,
  evidence: ScopeEvidence
): PreDispatchScopeReport["dispatchAdvice"] {
  const notes = dispatchNotes(implementationStatus, scopeSize, evidence);
  if (implementationStatus === "already_satisfied") {
    return {
      shouldBlock: true,
      reason: "work is already satisfied by prior AgentOS evidence",
      nextSafeAction: "verify the existing validation evidence and handoff; do not redispatch implementation for already-satisfied work",
      notes
    };
  }
  if (evidence.workspace.recoverable) {
    return {
      shouldBlock: true,
      reason: "recoverable partial workspace work exists",
      nextSafeAction: evidence.workspace.nextSafeAction ?? "resume the existing workspace and reconcile validation, commits, and PR state before redispatching",
      notes
    };
  }
  if (implementationStatus === "missing" && scopeSize === "large") {
    return {
      shouldBlock: true,
      reason: "likely-large scope needs planning or decomposition before implementation dispatch",
      nextSafeAction: "create or attach a planning/decomposition artifact, or split follow-up issues, before starting implementation",
      notes
    };
  }
  return {
    shouldBlock: false,
    reason: null,
    nextSafeAction: "dispatch implementation after the standard pre-dispatch checks pass",
    notes
  };
}

function dispatchNotes(implementationStatus: ScopeImplementationStatus, scopeSize: ScopeSize, evidence: ScopeEvidence): string[] {
  const notes = ["scope report evaluated before dispatch"];
  if (implementationStatus === "already_satisfied") notes.push("already-satisfied work should not be redispatched");
  if (scopeSize === "large") notes.push("likely-large scope should be planned or decomposed before implementation");
  if (implementationStatus === "partially_satisfied") notes.push("preserve existing partial-work evidence before starting a fresh implementation path");
  if (evidence.workspace.dirty && evidence.workspace.upstreamMissing) notes.push("dirty workspace with no upstream is recoverable partial work, not fresh missing work");
  if (evidence.lastRun.quietValidationStop) notes.push("last run appears to have stopped during a quiet validation command");
  return notes;
}
