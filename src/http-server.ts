import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IssueStateStore } from "./issue-state.js";
import { RunArtifactStore, type RunSummary } from "./runs.js";
import { RuntimeStateStore, type RuntimeState } from "./runtime-state.js";
import type { IssueState, ServiceConfig } from "./types.js";

export interface AgentOsApiState {
  schemaVersion: 1;
  generatedAt: string;
  runtime: RuntimeState;
  running: Array<{
    issueId: string;
    identifier: string;
    phase?: string;
    runId?: string;
    startedAt: string;
    lastEventAt?: string;
    workspacePath?: string;
  }>;
  retrying: Array<{
    issueId: string;
    identifier: string;
    attempt: number;
    dueAt: string;
    error: string | null;
    workspacePath?: string;
  }>;
  issues: IssueState[];
  runs: RunSummary[];
  codex_totals: {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  rate_limits: Array<Record<string, unknown>>;
}

export interface AgentOsIssueApiState {
  schemaVersion: 1;
  generatedAt: string;
  issue: IssueState | null;
  activeRun: RuntimeState["activeRuns"][number] | null;
  retry: RuntimeState["retryQueue"][number] | null;
  runs: RunSummary[];
}

export interface AgentOsHttpServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function buildAgentOsApiState(repoRoot: string, now = new Date()): Promise<AgentOsApiState> {
  const runtime = await new RuntimeStateStore(repoRoot).read();
  const issues = await new IssueStateStore(repoRoot).list();
  const runs = await new RunArtifactStore(repoRoot).listRuns();
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    runtime,
    running: runtime.activeRuns.map((entry) => ({
      issueId: entry.issueId,
      identifier: entry.identifier,
      ...(entry.phase ? { phase: entry.phase } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      startedAt: entry.startedAt,
      ...(entry.lastEventAt ? { lastEventAt: entry.lastEventAt } : {}),
      ...(entry.workspacePath ? { workspacePath: entry.workspacePath } : {})
    })),
    retrying: runtime.retryQueue.map((entry) => ({
      issueId: entry.issueId,
      identifier: entry.identifier,
      attempt: entry.attempt,
      dueAt: entry.dueAt,
      error: entry.error,
      ...(entry.workspacePath ? { workspacePath: entry.workspacePath } : {})
    })),
    issues,
    runs,
    codex_totals: codexTotals(runs),
    rate_limits: latestRateLimits(runs)
  };
}

export async function buildAgentOsIssueApiState(repoRoot: string, issueKey: string, now = new Date()): Promise<AgentOsIssueApiState | null> {
  const runtime = await new RuntimeStateStore(repoRoot).read();
  const issues = await new IssueStateStore(repoRoot).list();
  const issue = issues.find((candidate) => matchesIssue(candidate, issueKey)) ?? null;
  const activeRun = runtime.activeRuns.find((entry) => matchesIssueRuntime(entry, issueKey)) ?? null;
  const retry = runtime.retryQueue.find((entry) => matchesIssueRuntime(entry, issueKey)) ?? null;
  if (!issue && !activeRun && !retry) return null;
  const runs = (await new RunArtifactStore(repoRoot).listRuns()).filter((run) => run.issueIdentifier === issueKey || run.issueId === issueKey || run.issueIdentifier === issue?.issueIdentifier || run.issueId === issue?.issueId);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    issue,
    activeRun,
    retry,
    runs
  };
}

export async function startAgentOsHttpServer(input: {
  repoRoot: string;
  config?: ServiceConfig;
  port?: number | null;
  host?: string;
  onRefresh?: () => Promise<void>;
}): Promise<AgentOsHttpServerHandle | null> {
  const port = input.port ?? input.config?.server?.port ?? null;
  if (port == null) return null;
  const host = input.host ?? input.config?.server?.host ?? "127.0.0.1";
  let refresh: Promise<void> | null = null;
  const server = createServer(async (request, response) => {
    try {
      await routeRequest({
        repoRoot: input.repoRoot,
        request,
        response,
        onRefresh: input.onRefresh
          ? async () => {
              const onRefresh = input.onRefresh!;
              const coalesced = Boolean(refresh);
              if (!refresh) {
                refresh = onRefresh().finally(() => {
                  refresh = null;
                });
              }
              return { coalesced, refresh };
            }
          : undefined
      });
    } catch (error) {
      writeJson(response, 500, errorEnvelope("internal_error", error instanceof Error ? error.message : String(error)));
    }
  });
  await listen(server, port, host);
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    close: () => closeServer(server)
  };
}

async function routeRequest(input: {
  repoRoot: string;
  request: IncomingMessage;
  response: ServerResponse;
  onRefresh?: () => Promise<{ coalesced: boolean; refresh: Promise<void> }>;
}): Promise<void> {
  const method = input.request.method ?? "GET";
  const url = new URL(input.request.url ?? "/", "http://127.0.0.1");
  if (method === "GET" && url.pathname === "/") {
    writeHtml(input.response, await dashboardShell(input.repoRoot));
    return;
  }
  if (url.pathname === "/api/v1/state") {
    if (method !== "GET") return writeJson(input.response, 405, errorEnvelope("method_not_allowed", "GET required"));
    writeJson(input.response, 200, await buildAgentOsApiState(input.repoRoot));
    return;
  }
  if (url.pathname === "/api/v1/refresh") {
    if (method !== "POST") return writeJson(input.response, 405, errorEnvelope("method_not_allowed", "POST required"));
    if (!input.onRefresh) return writeJson(input.response, 202, { queued: false, coalesced: false, operations: [], requested_at: new Date().toISOString() });
    const result = await input.onRefresh();
    void result.refresh.catch(() => undefined);
    writeJson(input.response, 202, { queued: true, coalesced: result.coalesced, operations: ["poll", "reconcile"], requested_at: new Date().toISOString() });
    return;
  }
  const issueMatch = url.pathname.match(/^\/api\/v1\/([^/]+)$/);
  if (issueMatch) {
    if (method !== "GET") return writeJson(input.response, 405, errorEnvelope("method_not_allowed", "GET required"));
    const issue = await buildAgentOsIssueApiState(input.repoRoot, decodeURIComponent(issueMatch[1]));
    if (!issue) return writeJson(input.response, 404, errorEnvelope("issue_not_found", `unknown issue: ${decodeURIComponent(issueMatch[1])}`));
    writeJson(input.response, 200, issue);
    return;
  }
  writeJson(input.response, 404, errorEnvelope("not_found", `unknown route: ${url.pathname}`));
}

function codexTotals(runs: RunSummary[]): AgentOsApiState["codex_totals"] {
  return runs.reduce(
    (totals, run) => ({
      runs: totals.runs + 1,
      inputTokens: totals.inputTokens + (run.metrics.tokens.input ?? 0),
      outputTokens: totals.outputTokens + (run.metrics.tokens.output ?? 0),
      totalTokens: totals.totalTokens + (run.metrics.tokens.total ?? 0)
    }),
    { runs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}

function latestRateLimits(runs: RunSummary[]): Array<Record<string, unknown>> {
  for (const run of [...runs].reverse()) {
    if (run.metrics.rateLimits.length > 0) return run.metrics.rateLimits;
  }
  return [];
}

function matchesIssue(issue: IssueState, key: string): boolean {
  return issue.issueIdentifier === key || issue.issueId === key;
}

function matchesIssueRuntime(entry: { identifier: string; issueId: string; issue?: { id?: string; identifier?: string } }, key: string): boolean {
  return entry.identifier === key || entry.issueId === key || entry.issue?.identifier === key || entry.issue?.id === key;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function writeHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function errorEnvelope(code: string, message: string): { success: false; error: { code: string; message: string } } {
  return { success: false, error: { code, message } };
}

async function dashboardShell(repoRoot: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, "dashboard", "index.html"), "utf8");
  } catch {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentOS</title>
  <style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.4}pre{background:#f6f8fa;padding:1rem;overflow:auto}</style>
</head>
<body>
  <h1>AgentOS</h1>
  <pre id="state">Loading...</pre>
  <script>
    fetch("/api/v1/state").then((response) => response.json()).then((state) => {
      document.getElementById("state").textContent = JSON.stringify(state, null, 2);
    }).catch((error) => {
      document.getElementById("state").textContent = String(error);
    });
  </script>
</body>
</html>`;
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
