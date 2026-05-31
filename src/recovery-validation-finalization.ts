import type { ValidationReuseProfileState } from "./types.js";
import { writeValidationEvidence, type ValidationCommandEvidence, type ValidationEvidence } from "./validation.js";

export async function finalizeTrustedRecoveryValidationEvidence(input: {
  evidence?: ValidationEvidence;
  path?: string;
  issueIdentifier: string;
  branch: string | null;
  headSha: string;
  runId: string | null;
  reuseProfile: ValidationReuseProfileState;
  fullValidationCommand: string;
}): Promise<boolean> {
  if (!input.evidence || !input.path || !input.branch) return false;
  const command = finalRecoveryValidationCommand(input.evidence.commands, input.fullValidationCommand);
  if (!command) return false;
  await writeValidationEvidence(input.path, {
    ...input.evidence,
    schemaVersion: 1,
    issueIdentifier: input.issueIdentifier,
    repoHead: input.headSha,
    status: "passed",
    finalResult: {
      status: "passed",
      command: command.name,
      exitCode: command.exitCode,
      startedAt: command.startedAt,
      finishedAt: command.finishedAt
    },
    commands: input.evidence.commands,
    reuseProfile: input.reuseProfile,
    recovery: {
      kind: "clean-pushed-work",
      branch: input.branch,
      headSha: input.headSha,
      ...(input.runId ? { runId: input.runId } : {})
    }
  });
  return true;
}

function finalRecoveryValidationCommand(commands: ValidationCommandEvidence[], fullValidationCommand: string): ValidationCommandEvidence | null {
  const passingFullValidation = commands.filter((command) => command.name === fullValidationCommand && command.exitCode === 0);
  const passingCommands = commands.filter((command) => command.exitCode === 0);
  return passingFullValidation.at(-1) ?? passingCommands.at(-1) ?? null;
}
