export function lifecycleCommentKey(event: string, issueIdentifier: string): string {
  return `${event}:${issueIdentifier}`;
}

export function lifecycleCommentMarker(event: string, issueIdentifier: string): string {
  return `<!-- agentos:event=${lifecycleCommentKey(event, issueIdentifier)} -->`;
}
