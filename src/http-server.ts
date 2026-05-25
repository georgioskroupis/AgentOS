import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceConfig } from "./types.js";

export interface AgentOsHttpServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startAgentOsHttpServer(input: {
  repoRoot: string;
  config?: ServiceConfig;
  port?: number | null;
  host?: string;
}): Promise<AgentOsHttpServerHandle | null> {
  const port = input.port ?? input.config?.server?.port ?? null;
  if (port == null) return null;
  const host = input.host ?? input.config?.server?.host ?? "127.0.0.1";
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        if (method !== "GET") return writeJson(response, 405, errorEnvelope("method_not_allowed", "GET required"));
        writeHtml(response, await dashboardShell(input.repoRoot));
        return;
      }
      writeJson(response, 404, errorEnvelope("not_found", `unknown route: ${url.pathname}`));
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
  <title>AgentOS Monitor</title>
</head>
<body>
  <main>
    <h1>AgentOS Monitor</h1>
  </main>
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
