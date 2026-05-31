import type { PullRequestRef, Issue, IssueState } from "./types.js";

export interface ApprovedPullRequestLandingInput {
  issue: Issue;
  state: IssueState;
  mergeTarget: Pick<PullRequestRef, "url" | "role">;
}

export interface MergeStateExtension {
  name: string;
  processApprovedPullRequestLanding(input: ApprovedPullRequestLandingInput): Promise<boolean>;
  processMergeState(): Promise<void>;
}

export const noopMergeStateExtension: MergeStateExtension = {
  name: "noop-merge-state",
  async processApprovedPullRequestLanding() {
    return false;
  },
  async processMergeState() {}
};
