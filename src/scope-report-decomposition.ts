import type { Issue, ScopeDecompositionState } from "./types.js";

export function buildDecompositionEvidence(issue: Issue): ScopeDecompositionState {
  const children = issue.children ?? [];
  const parent = issue.parent ?? null;
  const childIdentifiers = children.map((child) => child.identifier).filter((identifier): identifier is string => Boolean(identifier));
  const terminalChildCount = children.filter((child) => isTerminalIssueState(child.state)).length;
  const activeChildCount = children.length - terminalChildCount;
  const issueIsParent = children.length > 0;
  const issueIsDecomposedChild = Boolean(parent?.identifier) || hasDecomposedChildToken(issue.identifier) || hasDecomposedChildToken(issue.title);
  const reasons: string[] = [];
  if (issueIsParent) {
    reasons.push(`${children.length} linked child issue(s)`);
    if (children.length === terminalChildCount) reasons.push("all linked child issues are terminal");
    else reasons.push(`${activeChildCount} linked child issue(s) still active`);
  }
  if (parent?.identifier) reasons.push(`linked parent issue ${parent.identifier}`);
  if (!parent?.identifier && issueIsDecomposedChild) reasons.push("title or identifier uses decomposed-child naming");
  return {
    present: issueIsParent || issueIsDecomposedChild,
    issueIsParent,
    issueIsDecomposedChild,
    childCount: children.length,
    terminalChildCount,
    activeChildCount,
    allChildrenTerminal: children.length > 0 && terminalChildCount === children.length,
    parentIdentifier: parent?.identifier ?? null,
    childIdentifiers,
    reasons
  };
}

function hasDecomposedChildToken(value: string | null | undefined): boolean {
  return /\b[A-Z][A-Z0-9]*-\d+[A-Z]+\b/.test(value ?? "");
}

function isTerminalIssueState(state: string | null): boolean {
  return /^(done|completed|canceled|cancelled|duplicate|closed)$/i.test((state ?? "").trim());
}
