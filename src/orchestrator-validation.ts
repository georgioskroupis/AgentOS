import type { Issue, ServiceConfig } from "./types.js";
import { verifyValidationEvidence } from "./validation.js";
import { validationReuseProfileForConfig } from "./validation-profile.js";

export function validationRunContext(config: ServiceConfig, issue: Issue, runId: string): string {
  const reuseProfile = validationReuseProfileForConfig(config);
  return [
    "",
    "## AgentOS Run Context",
    "",
    `Run ID: ${runId}`,
    `Validation evidence path: .agent-os/validation/${issue.identifier}.json`,
    "Include this run ID and the current `git rev-parse HEAD` value in the validation evidence JSON.",
    `Validation reuse profile JSON: ${JSON.stringify(reuseProfile)}`,
    "Record that object as `reuseProfile` in validation evidence. Reuse previous validation only when `repoHead` and `reuseProfile` both match and the evidence is still fresh."
  ].join("\n");
}

export function verifyHandoffValidationEvidence(input: {
  config: ServiceConfig;
  issue: Issue;
  handoff: string | null;
  workspacePath: string;
  runId?: string;
  selectedHeadSha?: string | null;
}): ReturnType<typeof verifyValidationEvidence> {
  return verifyValidationEvidence({
    issue: input.issue,
    handoff: input.handoff,
    workspacePath: input.workspacePath,
    runId: input.runId,
    selectedHeadSha: input.selectedHeadSha,
    allowReusableRunEvidence: true,
    validationBudget: input.config.validationBudget,
    reuseProfile: validationReuseProfileForConfig(input.config)
  });
}
