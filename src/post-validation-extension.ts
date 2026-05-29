import type { Issue, IssueState, Workspace } from "./types.js";

export interface PostValidationExtensionInput {
  issue: Issue;
  workspace: Workspace;
  state: IssueState | null;
  attempt: number | null;
  signal?: AbortSignal;
  runId?: string;
}

export interface PostValidationExtension {
  name: string;
  afterValidation(input: PostValidationExtensionInput): Promise<IssueState | null>;
}

export const noopPostValidationExtension: PostValidationExtension = {
  name: "noop-post-validation",
  async afterValidation(input) {
    return input.state;
  }
};

