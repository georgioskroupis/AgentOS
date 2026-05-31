import { createMergeShepherdExtension } from "./merge-state-shepherd-adapter.js";
import { createReviewFixerCiPostValidationExtension } from "./post-validation-review-adapter.js";

export function createDefaultPostValidationExtension(options: Parameters<typeof createReviewFixerCiPostValidationExtension>[0]) {
  return createReviewFixerCiPostValidationExtension(options);
}

export function createDefaultMergeStateExtension(options: Parameters<typeof createMergeShepherdExtension>[0]) {
  return createMergeShepherdExtension(options);
}
