import { chmod, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LauncherConfig } from "./monitor-extension-contracts.js";
import { defaultLauncherConfigPath, launcherUrl, parseLauncherConfig } from "./monitor-launcher.js";
import { ensureDir, exists, removePath } from "./fs-utils.js";

export type MonitorMacosInstallOptions = {
  repo: string;
  workflow: string;
  port: number;
  appPath?: string;
  configPath?: string;
  command?: string;
  homeDir?: string;
  nodeBinPath?: string;
};

export type MonitorMacosInstallResult = {
  appPath: string;
  configPath: string;
  config: LauncherConfig;
  url: string;
};

const appName = "AgentOS Monitor";
const bundleIdentifier = "dev.agentos.monitor";

export function defaultMonitorAppPath(homeDir = homedir()): string {
  return join(homeDir, "Applications", "AgentOS Monitor.app");
}

export async function installMacosMonitorApp(options: MonitorMacosInstallOptions): Promise<MonitorMacosInstallResult> {
  const repo = resolve(options.repo);
  await assertDirectory(repo, "Monitor repo");
  const workflow = options.workflow || "WORKFLOW.md";
  const workflowPath = isAbsolute(workflow) ? workflow : join(repo, workflow);
  if (!(await exists(workflowPath))) throw new Error(`Monitor workflow does not exist: ${workflowPath}`);

  const config = parseLauncherConfig({
    repo,
    workflow,
    host: "127.0.0.1",
    port: options.port,
    ...(options.command ? { command: options.command } : {})
  });
  const appPath = resolve(options.appPath ?? defaultMonitorAppPath(options.homeDir));
  const configPath = resolve(options.configPath ?? defaultLauncherConfigPath(options.homeDir));

  await writeLauncherConfig(configPath, config);
  await writeMonitorAppBundle(appPath, configPath, options.nodeBinPath);

  return { appPath, configPath, config, url: launcherUrl(config) };
}

export async function writeLauncherConfig(path: string, config: LauncherConfig): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function writeMonitorAppBundle(appPath: string, configPath = defaultLauncherConfigPath(), nodeBinPath = dirname(process.execPath)): Promise<void> {
  await removePath(appPath);
  const contents = join(appPath, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await ensureDir(macos);
  await ensureDir(resources);

  await writeFile(join(contents, "Info.plist"), monitorInfoPlist(), "utf8");
  await writeFile(join(contents, "PkgInfo"), "APPL????\n", "utf8");
  await writeFile(join(macos, appName), monitorAppExecutable(configPath, nodeBinPath), "utf8");
  await chmod(join(macos, appName), 0o755);
  await writeFile(join(resources, "main.cjs"), monitorElectronMain(), "utf8");
  await writeFile(join(resources, "preload.cjs"), monitorElectronPreload(), "utf8");
}

export function monitorInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

export function monitorAppExecutable(configPath: string, nodeBinPath = dirname(process.execPath)): string {
  const safeConfigPath = configPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const safeNodeBinPath = nodeBinPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `#!/usr/bin/env bash
set -euo pipefail

APP_EXECUTABLE="$0"
APP_CONTENTS="$(cd "$(dirname "$APP_EXECUTABLE")/.." && pwd)"
RESOURCES="$APP_CONTENTS/Resources"
CONFIG_PATH="\${AGENTOS_MONITOR_CONFIG:-${safeConfigPath}}"
INSTALL_NODE_BIN="${safeNodeBinPath}"

if [[ -n "$INSTALL_NODE_BIN" && -d "$INSTALL_NODE_BIN" ]]; then
  export PATH="$INSTALL_NODE_BIN:$PATH"
fi

for candidate in /opt/homebrew/bin /usr/local/bin; do
  if [[ -d "$candidate" ]]; then
    export PATH="$candidate:$PATH"
  fi
done

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # Dock-launched apps do not load shell startup files, so nvm-provided node/npx
  # are otherwise invisible.
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

if [[ -n "\${AGENTOS_MONITOR_ELECTRON:-}" ]]; then
  exec "\${AGENTOS_MONITOR_ELECTRON}" "$RESOURCES/main.cjs" "$CONFIG_PATH"
fi

repo="$(
  node -e 'const fs = require("fs"); try { const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.repo || ""); } catch {}' "$CONFIG_PATH" 2>/dev/null || true
)"

repo_electron="$repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ -n "$repo" && -x "$repo_electron" ]]; then
  exec "$repo_electron" "$RESOURCES/main.cjs" "$CONFIG_PATH"
fi

if command -v electron >/dev/null 2>&1; then
  exec electron "$RESOURCES/main.cjs" "$CONFIG_PATH"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx --yes electron@35.7.5 "$RESOURCES/main.cjs" "$CONFIG_PATH"
fi

osascript -e 'display dialog "AgentOS Monitor requires Electron. Install Electron in the repo, install a global electron command, or set AGENTOS_MONITOR_ELECTRON." buttons {"OK"} default button "OK"' >/dev/null 2>&1 || true
exit 1
`;
}

export function monitorElectronPreload(): string {
  return `"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentOsLauncher", {
  state: () => ipcRenderer.invoke("agentos-launcher:state"),
  start: () => ipcRenderer.invoke("agentos-launcher:start"),
  stop: () => ipcRenderer.invoke("agentos-launcher:stop"),
  reloadOpen: () => ipcRenderer.invoke("agentos-launcher:reload-open")
});
`;
}

export function monitorElectronMain(): string {
  return `"use strict";

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const healthPath = "/api/monitor/v1/health";
const launcherGracefulShutdownSignal = "SIGTERM";
const launcherEscalationSignal = "SIGKILL";
const gracefulShutdownMs = 3000;
const configPath = process.argv[2] || path.join(app.getPath("home"), "Library", "Application Support", "AgentOS Monitor", "config.json");
let manager;
let windowRef;

function readConfig() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object") throw new Error("Launcher config must be an object");
  if (typeof config.repo !== "string" || config.repo.length === 0) throw new Error("Launcher config repo must be a non-empty string");
  if (typeof config.workflow !== "string" || config.workflow.length === 0) throw new Error("Launcher config workflow must be a non-empty string");
  if (config.host !== "127.0.0.1") throw new Error("Launcher config host must be 127.0.0.1");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("Launcher config port must be an integer from 1 to 65535");
  if (config.command != null && (typeof config.command !== "string" || config.command.length === 0)) throw new Error("Launcher config command must be a non-empty string when provided");
  return config;
}

function monitorUrl(config) {
  return \`http://\${config.host}:\${config.port}\`;
}

function buildCommand(config) {
  return {
    command: config.command || "bin/agent-os",
    args: ["orchestrator", "run", "--repo", config.repo, "--workflow", config.workflow, "--port", String(config.port)],
    cwd: config.repo
  };
}

function portInUse(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
  });
}

async function healthOk(config) {
  try {
    const response = await fetch(\`\${monitorUrl(config)}\${healthPath}\`, { method: "GET", cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.json();
    return body && body.ok === true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off?.("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

class LauncherManager {
  constructor(config) {
    this.config = config;
    this.child = undefined;
    this.state = this.setState("stopped", { managedByLauncher: false });
  }

  currentState() {
    return { ...this.state };
  }

  async start() {
    this.setState("starting", { managedByLauncher: true });
    if (await portInUse(this.config.host, this.config.port)) {
      if (await healthOk(this.config)) {
        this.child = undefined;
        return this.setState("attached", { managedByLauncher: false });
      }
      return this.setState("failed", { managedByLauncher: false, lastError: \`Port \${this.config.port} is already in use by a non-AgentOS monitor process\` });
    }

    const command = buildCommand(this.config);
    this.child = spawn(command.command, command.args, { cwd: command.cwd, stdio: "ignore" });
    this.child.unref?.();
    this.setState("starting", { pid: this.child.pid, startedAt: new Date().toISOString(), managedByLauncher: true });
    try {
      await this.waitForReady();
      return this.setState("running", { pid: this.child && this.child.pid, startedAt: this.state.startedAt, managedByLauncher: true });
    } catch (error) {
      await this.stopOwned();
      return this.setState("failed", { managedByLauncher: false, lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  async stop() {
    if (!this.state.managedByLauncher || !this.child) return this.setState(this.state.status, { managedByLauncher: false });
    this.setState("stopping", { managedByLauncher: true });
    await this.stopOwned();
    return this.setState("stopped", { managedByLauncher: false });
  }

  async waitForReady() {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= 10000) {
      if (this.child && (this.child.exitCode != null || this.child.signalCode != null)) throw new Error("AgentOS launcher process exited before monitor health became ready");
      if (await healthOk(this.config)) return;
      await sleep(250);
    }
    throw new Error(\`Timed out waiting for \${monitorUrl(this.config)}\${healthPath}\`);
  }

  async stopOwned() {
    const child = this.child;
    if (!child) return;
    if (!childExited(child)) {
      child.kill(launcherGracefulShutdownSignal);
      const exited = await waitForExit(child, gracefulShutdownMs);
      if (!exited && !childExited(child)) {
        child.kill(launcherEscalationSignal);
        await waitForExit(child, 100);
      }
    }
    this.child = undefined;
  }

  setState(status, partial) {
    const managedByLauncher = Boolean(partial.managedByLauncher);
    this.state = {
      status,
      repo: this.config.repo,
      workflow: this.config.workflow,
      port: this.config.port,
      url: monitorUrl(this.config),
      managedByLauncher,
      stopEnabled: managedByLauncher && (status === "running" || status === "starting"),
      ...partial
    };
    return { ...this.state };
  }
}

async function loadProfilerWhenReady(state) {
  if (!windowRef) return;
  if (state.status === "running" || state.status === "attached") {
    await windowRef.loadURL(\`\${monitorUrl(manager.config)}/?mode=standalone\`);
    return;
  }
  await windowRef.loadURL(\`data:text/html;charset=utf-8,\${encodeURIComponent(\`<title>AgentOS Monitor</title><body><h1>AgentOS Monitor</h1><p>\${state.lastError || "Launcher failed"}</p></body>\`)}\`);
}

async function createWindow() {
  windowRef = new BrowserWindow({
    width: 1220,
    height: 820,
    title: "AgentOS Monitor",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  windowRef.on("closed", () => {
    windowRef = undefined;
  });
}

ipcMain.handle("agentos-launcher:state", () => manager.currentState());
ipcMain.handle("agentos-launcher:start", async () => {
  const state = await manager.start();
  await loadProfilerWhenReady(state);
  return state;
});
ipcMain.handle("agentos-launcher:stop", async () => manager.stop());
ipcMain.handle("agentos-launcher:reload-open", async () => {
  const state = manager.currentState();
  if (windowRef && (state.status === "running" || state.status === "attached")) await windowRef.loadURL(\`\${monitorUrl(manager.config)}/?mode=standalone\`);
  else await shell.openExternal(monitorUrl(manager.config));
  return manager.currentState();
});

app.whenReady().then(async () => {
  manager = new LauncherManager(readConfig());
  await createWindow();
  const state = await manager.start();
  await loadProfilerWhenReady(state);
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
    await loadProfilerWhenReady(manager.currentState());
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
`;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}
