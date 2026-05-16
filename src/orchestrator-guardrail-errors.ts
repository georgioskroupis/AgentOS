import { summarizeText } from "./output-capture.js";
import { redactText } from "./redaction.js";

const URL_CREDENTIAL_REDACTION_PATTERNS = [/(https?:\/\/)[^/\s@]+(?=@)/gi];

export function safeGuardrailErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return summarizeText(redactText(message, process.env, URL_CREDENTIAL_REDACTION_PATTERNS)).inline;
}
