import type { PostValidationExtension, PostValidationExtensionInput } from "./post-validation-extension.js";

export function createReviewFixerCiPostValidationExtension(
  runReviewFixerCiRepair: (input: PostValidationExtensionInput) => Promise<IssueStateOrNull>
): PostValidationExtension {
  return {
    name: "review-fixer-ci-repair",
    afterValidation: runReviewFixerCiRepair
  };
}

type IssueStateOrNull = Awaited<ReturnType<PostValidationExtension["afterValidation"]>>;
