import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_IDENTITY_RELATIVE_PATH, readDaemonIdentity, writeDaemonIdentity } from "../src/daemon-identity.js";

describe("daemon identity metadata", () => {
  it("writes deterministic repo-local metadata without secret-shaped values", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-identity-"));

    await writeDaemonIdentity(repo, {
      pid: 12345,
      startedAt: "2026-05-21T12:00:00.000Z",
      startGitSha: `abc123 sk-${"abcdefghijklmnopqrstuvwxyz"}`
    });

    const raw = await readFile(join(repo, DAEMON_IDENTITY_RELATIVE_PATH), "utf8");
    expect(raw).toBe(
      JSON.stringify(
        {
          schemaVersion: 1,
          repoRoot: resolve(repo),
          pid: 12345,
          startedAt: "2026-05-21T12:00:00.000Z",
          startGitSha: "abc123_[REDACTED]"
        },
        null,
        2
      ) + "\n"
    );
    expect(raw).not.toContain("sk-");
  });

  it("classifies missing and stale metadata without throwing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-identity-read-"));

    await expect(readDaemonIdentity(repo)).resolves.toMatchObject({
      status: "missing",
      identity: null,
      message: "daemon identity metadata is missing"
    });

    await writeDaemonIdentity(repo, {
      pid: 999999,
      startedAt: "2026-05-21T12:00:00.000Z",
      startGitSha: "abc123"
    });

    await expect(readDaemonIdentity(repo, { isProcessAlive: () => false })).resolves.toMatchObject({
      status: "stale",
      identity: expect.objectContaining({ pid: 999999 }),
      message: "daemon identity pid 999999 is not running"
    });
  });

  it("classifies active and invalid metadata", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-identity-active-"));
    await writeDaemonIdentity(repo, {
      pid: process.pid,
      startedAt: "2026-05-21T12:00:00.000Z",
      startGitSha: "abc123"
    });

    await expect(readDaemonIdentity(repo, { isProcessAlive: () => true })).resolves.toMatchObject({
      status: "active",
      identity: expect.objectContaining({
        repoRoot: resolve(repo),
        pid: process.pid,
        startedAt: "2026-05-21T12:00:00.000Z",
        startGitSha: "abc123"
      })
    });

    await writeFile(join(repo, DAEMON_IDENTITY_RELATIVE_PATH), "{bad json", "utf8");
    await expect(readDaemonIdentity(repo)).resolves.toMatchObject({
      status: "invalid",
      identity: null
    });
  });
});
