export interface MergeStateExtension {
  name: string;
  processMergeState(): Promise<void>;
}

export const noopMergeStateExtension: MergeStateExtension = {
  name: "noop-merge-state",
  async processMergeState() {}
};
