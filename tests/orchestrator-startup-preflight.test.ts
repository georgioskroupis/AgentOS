import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_IDENTITY_RELATIVE_PATH, writeDaemonIdentity } from "../src/daemon-identity.js";
import { evaluateOrchestratorStartupPreflight } from "../src/orchestrator-startup-preflight.js";
import type { DaemonPreflightResult } from "../src/env.js";

describe("orchestrator startup singleton preflight", () => {
  it("refuses startup when a same-repo daemon identity is live", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-startup-preflight-refuse-"));
    await writeDaemonIdentity(repo, {
      pid: 12345,
      startedAt: "2026-05-21T12:00:00.000Z",
      startGitSha: "abc123"
    });

    const result = await evaluateOrchestratorStartupPreflight({
      repoRoot: repo,
      daemonPreflight: readyDaemonPreflight(repo),
      singletonGuardOptions: { isProcessAlive: () => true }
    });

    expect(result).toMatchObject({
      decision: "refuse",
      allowed: false,
      message: expect.stringContaining(`refusing to start AgentOS daemon for ${resolve(repo)}`),
      daemonPreflight: {
        status: "singleton_conflict",
        message: expect.stringContaining("already running for this repo")
      },
      singletonGuard: {
        decision: "refuse",
        identityStatus: "active"
      }
    });
  });

  it("allows startup when active daemon metadata belongs to the current process", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-startup-preflight-current-pid-"));
    await writeDaemonIdentity(repo, {
      pid: process.pid,
      startedAt: "2026-05-21T12:00:00.000Z",
      startGitSha: "abc123"
    });

    await expect(
      evaluateOrchestratorStartupPreflight({
        repoRoot: repo,
        daemonPreflight: readyDaemonPreflight(repo),
        singletonGuardOptions: { isProcessAlive: () => true }
      })
    ).resolves.toMatchObject({
      decision: "allow",
      allowed: true,
      daemonPreflight: { status: "ready" },
      singletonGuard: {
        decision: "refuse",
        identityStatus: "active"
      }
    });
  });

  it("allows startup for missing, invalid, stale, and different-repo daemon identity", async () => {
    const missingRepo = await mkdtemp(join(tmpdir(), "agent-os-startup-preflight-missing-"));
    await expect(
      evaluateOrchestratorStartupPreflight({
        repoRoot: missingRepo,
        daemonPreflight: readyDaemonPreflight(missingRepo)
      })
    ).resolves.toMatchObject({
      decision: "allow",
      allowed: true,
      daemonPreflight: { status: "ready" },
      singletonGuard: { identityStatus: "missing" }
    });

    const invalidRepo = await mkdtemp(join(tmpdir(), "agent-os-startup-preflight-invalid-"));
    await mkdir(join(invalidRepo, ".agent-os", "state"), { recursive: true });
    await writeFile(join(invalidRepo, DAEMON_IDENTITY_RELATIVE_PATH), "{bad json", "utf8");
    await expect(
      evaluateOrchestratorStartupPreflight({
        repoRoot: invalidRepo,
        daemonPreflight: readyDaemonPreflight(invalidRepo)
      })
    ).resolves.toMatchObject({
      decision: "allow",
      allowed: true,
      daemonPreflight: { status: "ready" },
      singletonGuard: { identityStatus: "invalid" }
    });

    const staleRepo = await mkdtemp(join(tmpdir(), "agent-os-startup-preflight-stale-"));
    await writeDaemonIdentity(staleRepo, {
      pid: process.pid,
      startedAt: "2026-05-21T12:00:00.000Z",
      startGitSha: "abc123"
    });
    await expect(
      evaluateOrchestratorStartupPreflight({
        repoRoot: staleRepo,
        daemonPreflight: readyDaemonPreflight(staleRepo),
        singletonGuardOptions: { isProcessAlive: () => false }
      })
    ).resolves.toMatchObject({
      decision: "allow",
      allowed: true,
      daemonPreflight: { status: "ready" },
      singletonGuard: { identityStatus: "stale" }
    });

    const candidateRepo = await mkdtemp(join(tmpdir(), "agent-os-startup-preflight-candidate-"));
    const otherRepo = await mkdtemp(join(tmpdir(), "agent-os-startup-preflight-other-"));
    await mkdir(join(candidateRepo, ".agent-os", "state"), { recursive: true });
    await writeFile(
      join(candidateRepo, DAEMON_IDENTITY_RELATIVE_PATH),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repoRoot: resolve(otherRepo),
          pid: process.pid,
          startedAt: "2026-05-21T12:00:00.000Z",
          startGitSha: "abc123"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await expect(
      evaluateOrchestratorStartupPreflight({
        repoRoot: candidateRepo,
        daemonPreflight: readyDaemonPreflight(candidateRepo),
        singletonGuardOptions: { isProcessAlive: () => true }
      })
    ).resolves.toMatchObject({
      decision: "allow",
      allowed: true,
      daemonPreflight: { status: "ready" },
      singletonGuard: { identityStatus: "invalid" }
    });
  });
});

function readyDaemonPreflight(repoRoot: string): DaemonPreflightResult {
  return {
    status: "ready",
    message: "required daemon credentials are available",
    repoEnvPath: join(repoRoot, ".agent-os", "env"),
    repoEnvStatus: "missing",
    loadedKeys: [],
    errors: [],
    tracker: {
      linearApiKey: "present",
      projectSlug: "present"
    },
    github: {
      command: "configured",
      required: false,
      auth: "unchecked"
    },
    codex: {
      command: "configured"
    }
  };
}
