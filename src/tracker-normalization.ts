import type { Issue } from "./types.js";

export function normalizeTrackerIssue(input: Issue): Issue {
  return {
    ...input,
    id: String(input.id),
    identifier: String(input.identifier),
    title: String(input.title),
    description: typeof input.description === "string" ? input.description : null,
    priority: Number.isInteger(input.priority) ? input.priority : null,
    state: String(input.state),
    branch_name: typeof input.branch_name === "string" ? input.branch_name : null,
    url: typeof input.url === "string" ? input.url : null,
    labels: input.labels.map((label) => label.toLowerCase()),
    blocked_by: input.blocked_by.map(normalizeIssueRef),
    parent: input.parent ? normalizeIssueRef(input.parent) : null,
    children: input.children?.map(normalizeIssueRef) ?? [],
    created_at: normalizeIsoTime(input.created_at),
    updated_at: normalizeIsoTime(input.updated_at)
  };
}

function normalizeIssueRef(ref: Issue["blocked_by"][number]): Issue["blocked_by"][number] {
  return {
    id: ref.id == null ? null : String(ref.id),
    identifier: ref.identifier == null ? null : String(ref.identifier),
    state: ref.state == null ? null : String(ref.state),
    created_at: normalizeIsoTime(ref.created_at ?? null),
    updated_at: normalizeIsoTime(ref.updated_at ?? null)
  };
}

function normalizeIsoTime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : value;
}
