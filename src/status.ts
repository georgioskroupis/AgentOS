import { resolve } from "node:path";
import { JsonlLogger } from "./logging.js";

export async function getStatus(repo = process.cwd(), limit = 20): Promise<string> {
  const logger = new JsonlLogger(resolve(repo));
  const entries = await logger.tail(limit);
  if (entries.length === 0) {
    return "No AgentOS run events recorded.";
  }
  return entries
    .map((entry) => {
      const issue = entry.issueIdentifier ? ` ${entry.issueIdentifier}` : "";
      const message = entry.message ? ` - ${entry.message}` : "";
      return `${entry.timestamp} ${entry.type}${issue}${message}`;
    })
    .join("\n");
}

