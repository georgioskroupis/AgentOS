import type { ServiceConfig } from "./types.js";

type FetchLike = typeof fetch;

export interface ClientToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LinearGraphqlToolResult {
  success: boolean;
  response?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function linearGraphqlClientTools(config: ServiceConfig): ClientToolDefinition[] {
  if (!isLinearGraphqlToolAvailable(config)) return [];
  return [
    {
      name: "linear_graphql",
      description: "Run one Linear GraphQL operation through the configured AgentOS tracker credentials.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          variables: { type: "object" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  ];
}

export function isLinearGraphqlToolAvailable(config: ServiceConfig): boolean {
  return config.lifecycle?.mode === "agent-owned" && config.tracker.kind === "linear" && Boolean(config.tracker.apiKey);
}

export async function handleClientToolCall(input: {
  config: ServiceConfig;
  name: string;
  arguments: unknown;
  fetchImpl?: FetchLike;
}): Promise<LinearGraphqlToolResult> {
  if (input.name !== "linear_graphql") {
    return { success: false, error: { code: "unsupported_tool", message: `unsupported client tool: ${input.name}` } };
  }
  return executeLinearGraphql(input.config, input.arguments, input.fetchImpl ?? fetch);
}

export async function executeLinearGraphql(config: ServiceConfig, rawInput: unknown, fetchImpl: FetchLike = fetch): Promise<LinearGraphqlToolResult> {
  if (config.tracker.kind !== "linear") return { success: false, error: { code: "unsupported_tracker_kind", message: "linear_graphql requires tracker.kind=linear" } };
  if (config.lifecycle.mode !== "agent-owned") return { success: false, error: { code: "tool_unavailable", message: "linear_graphql is available only in lifecycle.mode=agent-owned" } };
  if (!config.tracker.apiKey) return { success: false, error: { code: "missing_auth", message: "Linear API key is not configured" } };

  const parsed = parseLinearGraphqlInput(rawInput);
  if (!parsed.ok) return { success: false, error: parsed.error };

  try {
    const response = await fetchImpl(config.tracker.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: config.tracker.apiKey
      },
      body: JSON.stringify({ query: parsed.query, variables: parsed.variables ?? {} })
    });
    const body = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
    if (!response.ok) {
      return { success: false, response: body, error: { code: "transport_error", message: `Linear GraphQL request failed with HTTP ${response.status}`, details: body } };
    }
    if (body && typeof body === "object" && Array.isArray((body as { errors?: unknown }).errors)) {
      return { success: false, response: body };
    }
    return { success: true, response: body };
  } catch (error) {
    return { success: false, error: { code: "transport_error", message: error instanceof Error ? error.message : String(error) } };
  }
}

function parseLinearGraphqlInput(rawInput: unknown): { ok: true; query: string; variables?: Record<string, unknown> } | { ok: false; error: LinearGraphqlToolResult["error"] } {
  const input = typeof rawInput === "string" ? { query: rawInput } : rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidInput("linear_graphql input must be an object or raw GraphQL query string");
  const query = (input as { query?: unknown }).query;
  if (typeof query !== "string" || !query.trim()) return invalidInput("query must be a non-empty string");
  const variables = (input as { variables?: unknown }).variables;
  if (variables != null && (!variables || typeof variables !== "object" || Array.isArray(variables))) return invalidInput("variables must be a JSON object when provided");
  if (!containsExactlyOneGraphqlOperation(query)) return invalidInput("query must contain exactly one GraphQL operation");
  return { ok: true, query: query.trim(), ...(variables ? { variables: variables as Record<string, unknown> } : {}) };
}

function invalidInput(message: string): { ok: false; error: NonNullable<LinearGraphqlToolResult["error"]> } {
  return { ok: false, error: { code: "invalid_input", message } };
}

function containsExactlyOneGraphqlOperation(query: string): boolean {
  const withoutComments = query.replace(/#[^\n\r]*/g, " ");
  const trimmed = withoutComments.trim();
  if (trimmed.startsWith("{")) return !/\b(query|mutation|subscription)\b[\s\S]*\b(query|mutation|subscription)\b/i.test(trimmed);
  const matches = trimmed.match(/\b(query|mutation|subscription)\b/gi) ?? [];
  return matches.length === 1;
}
