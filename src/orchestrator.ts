import { join, resolve } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { evaluateMergeReadiness, GitHubClient, summarizeFeedback, summarizePullRequestForPrompt } from "./github.js";
import { issueStateFromHandoff, IssueStateStore } from "./issue-state.js";
import { JsonlLogger } from "./logging.js";
import { LinearClient } from "./linear.js";
import { redactText } from "./redaction.js";
import { blockingFindings, ensureReviewIterationDir, fixPrompt, formatFindings, readReviewArtifact, repeatedBlockingHashes, reviewArtifactPath, reviewerPrompt } from "./review.js";
import { CodexAppServerRunner } from "./runner/app-server.js";
import { RunArtifactStore } from "./runs.js";
import { validationEvidenceFinding, verifyValidationEvidence } from "./validation.js";
import { loadWorkflow, renderPrompt, resolveServiceConfig, validateDispatchConfig } from "./workflow.js";
import { WorkspaceManager } from "./workspace.js";
import type { AgentEvent, AgentRunResult, AgentRunner, Issue, IssueState, IssueTracker, ReviewFinding, ReviewStateReviewer, ReviewStatus, RunErrorCategory, ServiceConfig, WorkflowDefinition, Workspace } from "./types.js";
import type { ReviewerArtifact } from "./review.js";

export interface OrchestratorOptions {
  repoRoot: string;
  workflowPath: string;
  tracker?: IssueTracker;
  runner?: AgentRunner;
  logger?: JsonlLogger;
  env?: NodeJS.ProcessEnv;
}

interface RunningEntry {
  issue: Issue;
  startedAt: number;
  abortController: AbortController;
  promise: Promise<void>;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  issue: Issue;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export class Orchestrator {
  private workflow!: WorkflowDefinition;
  private config!: ServiceConfig;
  private tracker!: IssueTracker;
  private runner!: AgentRunner;
  private logger: JsonlLogger;
  private runArtifacts: RunArtifactStore;
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retries = new Map<string, RetryEntry>();
  private completedMarkers = new Map<string, string>();
  private mergeWaitingMarkers = new Map<string, string>();
  private startupCleanupDone = false;

  constructor(private readonly options: OrchestratorOptions) {
    this.logger = options.logger ?? new JsonlLogger(resolve(options.repoRoot));
    this.runArtifacts = new RunArtifactStore(resolve(options.repoRoot));
  }

  async reload(): Promise<void> {
    this.workflow = await loadWorkflow(this.options.workflowPath);
    this.config = resolveServiceConfig(this.workflow, this.options.env);
    this.tracker = this.options.tracker ?? new LinearClient(this.config.tracker);
    this.runner = this.options.runner ?? new CodexAppServerRunner();
  }

  async runOnce(waitForWorkers = true): Promise<void> {
    await this.reload();
    await this.cleanupTerminalWorkspaces();
    await this.reconcile();
    validateDispatchConfig(this.config);
    await this.dispatchDueRetries();
    if (this.config.github.mergeMode !== "manual") {
      await this.shepherdMergingIssues();
    }
    const candidates = await this.tracker.fetchCandidates(this.config.tracker.activeStates);
    for (const issue of candidates) {
      if (!this.isEligible(issue)) continue;
      if (this.running.size >= this.config.agent.maxConcurrentAgents) break;
      if (!this.hasSlot(issue.state)) continue;
      const retry = this.retries.get(issue.id);
      this.dispatch(issue, retry && retry.dueAtMs <= Date.now() ? retry.attempt : null);
    }
    if (waitForWorkers) {
      await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
    }
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    await this.reload();
    while (!signal.aborted) {
      try {
        await this.runOnce(false);
      } catch (error) {
        await this.logger.write({
          type: "orchestrator_error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      await sleep(this.config.polling.intervalMs, signal);
    }
  }

  private async writeRunEvent(runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }): Promise<void> {
    const payload = await this.logger.write({ ...entry, runId });
    await this.runArtifacts.writeEvent(runId, payload);
  }

  private dispatch(issue: Issue, attempt: number | null): void {
    this.claimed.add(issue.id);
    this.retries.delete(issue.id);
    this.completedMarkers.delete(issue.id);
    const abortController = new AbortController();
    const promise = this.runIssue(issue, attempt, abortController).finally(() => {
      this.running.delete(issue.id);
      this.claimed.delete(issue.id);
    });
    this.running.set(issue.id, {
      issue,
      startedAt: Date.now(),
      abortController,
      promise
    });
  }

  private async runIssue(issue: Issue, attempt: number | null, abortController: AbortController): Promise<void> {
    const run = await this.runArtifacts.startRun({ issue, attempt });
    const runId = run.runId;
    await this.writeRunEvent(runId, {
      type: "run_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: issue.title
    });
    const stateStore = new IssueStateStore(resolve(this.options.repoRoot));
    await this.recordIssueState(issue, { phase: "workspace", lastRunId: runId });
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    const workspace = await workspaceManager.createOrReuse(issue.identifier);
    await this.runArtifacts.setWorkspace(runId, workspace);
    try {
      await this.markLinearStarted(issue, workspace, attempt);
      await workspaceManager.beforeRun(workspace);
      const result = await this.runImplementationTurns(issue, attempt, workspace, abortController.signal, runId);
      await this.writeRunEvent(runId, {
        type: `run_${result.status}`,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: result.error ?? "completed",
        payload: result
      });
      if (result.status !== "succeeded") {
        await this.handleFailedRun(issue, workspace, attempt, result.error ?? result.status);
      } else {
        this.completedMarkers.set(issue.id, completionMarker(issue));
        const handoff = await readHandoff(workspace.path, issue.identifier);
        if (handoff) await this.runArtifacts.writeHandoff(runId, handoff);
        const stateFromHandoff = handoff ? issueStateFromHandoff(issue, handoff) : null;
        const validation = handoff ? await verifyValidationEvidence({ issue, handoff, workspacePath: workspace.path, runId }) : null;
        const persistedState = stateFromHandoff
          ? await stateStore.merge(issue.identifier, {
              ...stateFromHandoff,
              ...(validation ? { validation: validation.state } : {})
            })
          : await stateStore.read(issue.identifier);
        if (stateFromHandoff) {
          await this.logger.write({
            type: stateFromHandoff.prUrl ? "pr_metadata_persisted" : "issue_state_persisted",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: stateFromHandoff.prUrl ?? stateFromHandoff.outcome,
            payload: stateFromHandoff
          });
          if (stateFromHandoff.outcome === "already_satisfied") {
            await this.logger.write({
              type: "issue_already_satisfied",
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              message: "agent reported acceptance criteria were already satisfied",
              payload: stateFromHandoff
            });
          }
        }
        const reviewedState = await this.reviewIfNeeded(issue, workspace, persistedState, attempt, abortController.signal);
        await this.markLinearSucceeded(issue, workspace, handoff, reviewedState ?? persistedState ?? undefined);
      }
      await this.runArtifacts.completeRun(runId, result);
    } catch (error) {
      await this.handleFailedRun(issue, workspace, attempt, error instanceof Error ? error.message : String(error));
      await this.writeRunEvent(runId, {
        type: "run_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: error instanceof Error ? error.message : String(error)
      });
      await this.runArtifacts.failRun(runId, error instanceof Error ? error.message : String(error));
      await this.recordIssueState(issue, {
        errorCategory: categorizeRunError(error instanceof Error ? error.message : String(error)),
        lastError: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await workspaceManager.afterRun(workspace);
    }
  }

  private async runImplementationTurns(issue: Issue, attempt: number | null, workspace: Workspace, signal: AbortSignal | undefined, runId: string): Promise<AgentRunResult> {
    let result: AgentRunResult = { status: "failed", error: "no_turn_started" };
    for (let turnNumber = 1; turnNumber <= this.config.agent.maxTurns; turnNumber += 1) {
      await this.recordIssueState(issue, { phase: "prompt" });
      const prompt = await this.implementationPrompt(issue, attempt, turnNumber, runId);
      await this.runArtifacts.writePrompt(runId, prompt);
      await this.recordIssueState(issue, { phase: "streaming-turn" });
      result = await this.runner.run({
        issue,
        prompt,
        attempt,
        workspace,
        config: this.config,
        signal,
        onEvent: (event) => void this.writeRunEvent(runId, { ...event, runId })
      });
      await this.writeRunEvent(runId, {
        type: "turn_completed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `turn ${turnNumber} ${result.status}`,
        payload: { turnNumber, maxTurns: this.config.agent.maxTurns, result }
      });
      if (result.status !== "succeeded") return result;
      if (await readHandoff(workspace.path, issue.identifier)) return result;

      const current = await this.tracker.fetchIssueStates([issue.id]).then((states) => states.get(issue.id)).catch(() => null);
      if (current && !isStateIn(current.state, runningAllowedStates(this.config))) return result;
      if (turnNumber < this.config.agent.maxTurns) {
        await this.logger.write({
          type: "turn_continued",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: "successful turn ended without a handoff; continuing within max_turns",
          payload: { turnNumber, maxTurns: this.config.agent.maxTurns }
        });
      }
    }
    return result;
  }

  private async implementationPrompt(issue: Issue, attempt: number | null, turnNumber: number, runId: string): Promise<string> {
    const base = await renderPrompt(this.workflow.prompt_template, issue, attempt);
    const runContext = [
      "",
      "## AgentOS Run Context",
      "",
      `Run ID: ${runId}`,
      `Validation evidence path: .agent-os/validation/${issue.identifier}.json`,
      "Include this run ID and the current `git rev-parse HEAD` value in the validation evidence JSON."
    ].join("\n");
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(issue.identifier);
    const continuation = turnNumber > 1
      ? [
          "",
          "## AgentOS Continuation",
          "",
          `This is turn ${turnNumber} of ${this.config.agent.maxTurns}. The previous turn completed without writing the required handoff file.`,
          "Continue the same issue in this workspace and write the required `.agent-os/handoff-<issue>.md` before finishing."
        ].join("\n")
      : "";
    if (!state?.prUrl || issue.state.toLowerCase() !== "todo") return `${base}${runContext}${continuation}`;

    const feedback = await this.githubFeedbackSummary(state.prUrl).catch((error: Error) => `Could not fetch GitHub feedback: ${error.message}`);
    return [
      base,
      runContext,
      continuation,
      "",
      "## Existing PR Feedback Re-entry",
      "",
      "AgentOS found an existing pull request for this issue. Treat this run as a feedback-fix/update pass, not a fresh implementation.",
      "",
      `Existing PR: ${state.prUrl}`,
      "",
      feedback || "No recent feedback was found.",
      "",
      "Update the existing branch and PR, rerun validation, and refresh the handoff file."
    ].join("\n");
  }

  private async githubFeedbackSummary(prUrl: string): Promise<string> {
    const github = new GitHubClient(this.config.github.command);
    const status = await github.getPullRequest(prUrl, resolve(this.options.repoRoot));
    const threads = await github.getPullRequestReviewThreads(prUrl, resolve(this.options.repoRoot)).catch(() => []);
    return summarizeFeedback(status, threads);
  }

  private async dispatchDueRetries(): Promise<void> {
    const due = [...this.retries.values()]
      .filter((retry) => retry.dueAtMs <= Date.now())
      .sort((a, b) => a.dueAtMs - b.dueAtMs);
    if (due.length === 0) return;

    const states = await this.tracker.fetchIssueStates(due.map((retry) => retry.issueId)).catch(() => null);
    for (const retry of due) {
      if (this.running.size >= this.config.agent.maxConcurrentAgents) break;
      if (this.running.has(retry.issueId) || this.claimed.has(retry.issueId)) continue;
      const current = states?.get(retry.issueId);
      if (current === null) {
        this.retries.delete(retry.issueId);
        continue;
      }
      const issue = current ?? retry.issue;
      if (isStateIn(issue.state, this.config.tracker.terminalStates)) {
        this.retries.delete(retry.issueId);
        continue;
      }
      if (!this.hasSlot(issue.state)) continue;
      this.dispatch(issue, retry.attempt);
    }
  }

  private async cleanupTerminalWorkspaces(): Promise<void> {
    if (this.startupCleanupDone) return;
    this.startupCleanupDone = true;
    if (!this.tracker.fetchTerminalIssues) return;
    try {
      const issues = await this.tracker.fetchTerminalIssues(this.config.tracker.terminalStates);
      const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
      for (const issue of issues) {
        await workspaceManager.remove(issue.identifier);
        await this.logger.write({
          type: "workspace_cleaned",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: "terminal issue workspace removed at startup"
        });
      }
    } catch (error) {
      await this.logger.write({
        type: "workspace_cleanup_warning",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async reconcile(): Promise<void> {
    const stale: string[] = [];
    for (const [id, entry] of this.running.entries()) {
      const elapsed = Date.now() - entry.startedAt;
      if (this.config.codex.stallTimeoutMs > 0 && elapsed > this.config.codex.stallTimeoutMs) {
        entry.abortController.abort();
        stale.push(id);
      }
    }
    if (this.running.size === 0) return;
    const states = await this.tracker.fetchIssueStates([...this.running.keys()]).catch(() => null);
    if (!states) return;
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    for (const [id, issue] of states.entries()) {
      const running = this.running.get(id);
      if (!running || !issue) continue;
      const normalized = issue.state.toLowerCase();
      if (this.config.tracker.terminalStates.map((state) => state.toLowerCase()).includes(normalized)) {
        running.abortController.abort();
        await workspaceManager.remove(issue.identifier);
      } else if (!isStateIn(issue.state, runningAllowedStates(this.config))) {
        running.abortController.abort();
      }
    }
    for (const id of stale) {
      await this.logger.write({ type: "run_stalled", issueId: id, message: "stall timeout exceeded" });
    }
  }

  private async shepherdMergingIssues(): Promise<void> {
    const mergeState = this.config.tracker.mergeState;
    if (!mergeState) return;
    const issues = await this.tracker.fetchCandidates([mergeState]);
    for (const issue of issues) {
      await this.shepherdMergeIssue(issue);
    }
  }

  private async reviewIfNeeded(issue: Issue, workspace: Workspace, state: IssueState | null, attempt: number | null, signal?: AbortSignal): Promise<IssueState | null> {
    if (!this.config.review.enabled) return state;
    if (!state?.prUrl || state.outcome === "already_satisfied") return state;

    await this.commentIssue(
      issue,
      [
        "### AgentOS automated review started",
        "",
        "The Ralph Wiggum loop is reviewing this PR before moving the issue to Human Review.",
        "",
        `- PR: ${state.prUrl}`,
        `- Required reviewers: ${this.config.review.requiredReviewers.join(", ")}`,
        `- Max iterations: ${this.config.review.maxIterations}`
      ].join("\n")
    );

    let previousFindings = state.findings ?? [];
    let latestState = await this.recordIssueState(issue, { phase: "review", reviewStatus: "pending", reviewIteration: state.reviewIteration ?? 0 });
    for (let iteration = (state.reviewIteration ?? 0) + 1; iteration <= this.config.review.maxIterations; iteration += 1) {
      await ensureReviewIterationDir(resolve(this.options.repoRoot), issue.identifier, iteration);
      const githubContext = await this.githubReviewContext(state.prUrl).catch(async (error: Error) => {
        latestState = await this.recordIssueState(issue, {
          phase: "review",
          reviewStatus: "human_required",
          lastError: error.message,
          errorCategory: "review"
        });
        await this.commentIssue(issue, `### AgentOS automated review needs human judgment\n\nAgentOS could not read the pull request for review.\n\n- PR: ${state.prUrl}\n- Error: ${error.message}`);
        await this.logger.write({
          type: "review_human_required",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: error.message,
          payload: { prUrl: state.prUrl }
        });
        return null;
      });
      if (!githubContext) return latestState;
      if (githubContext.status.state && githubContext.status.state.toUpperCase() !== "OPEN") {
        latestState = await this.recordIssueState(issue, {
          phase: "review",
          reviewStatus: "human_required",
          lastError: `pull request is ${githubContext.status.state}`,
          errorCategory: "review"
        });
        await this.commentIssue(issue, `### AgentOS automated review needs human judgment\n\nPull request is not open.\n\n- PR: ${state.prUrl}\n- State: ${githubContext.status.state}`);
        return latestState;
      }
      const reviewers = this.reviewersFor(githubContext.status.changedFiles);
      const artifacts: Array<{ artifact: ReviewerArtifact; path: string }> = [];

      await this.logger.write({
        type: "review_started",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `iteration ${iteration}`,
        payload: { prUrl: state.prUrl, reviewers }
      });

      for (const reviewer of reviewers) {
        const artifactPath = reviewArtifactPath(resolve(this.options.repoRoot), issue.identifier, iteration, reviewer);
        const prompt = reviewerPrompt({
          issue,
          prUrl: state.prUrl,
          iteration,
          reviewer,
          artifactPath,
          githubSummary: githubContext.summary,
          feedbackSummary: githubContext.feedback
        });
        const result = await this.runner.run({
          issue,
          prompt,
          attempt,
          workspace,
          config: readOnlyReviewConfig(this.config, resolve(this.options.repoRoot)),
          signal,
          onEvent: (event) => void this.logger.write({ ...event, type: `review_${event.type}` })
        });
        if (result.status !== "succeeded") {
          await this.logger.write({
            type: "review_runner_failed",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: `${reviewer}: ${result.error ?? result.status}`
          });
        }
        const artifact = await readReviewArtifact(artifactPath, reviewer);
        artifacts.push({ artifact, path: artifactPath });
        for (const finding of artifact.findings) {
          await this.logger.write({
            type: "review_finding",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: finding.body,
            payload: finding
          });
        }
      }

      const validationFinding = validationEvidenceFinding(latestState?.validation);
      const findings = [
        ...artifacts.flatMap((entry) => entry.artifact.findings),
        ...reviewCheckFindings(githubContext.status, this.config),
        ...(validationFinding ? [validationFinding] : [])
      ];
      for (const finding of findings.filter((finding) => finding.reviewer === "checks")) {
        await this.logger.write({
          type: "review_finding",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: finding.body,
          payload: finding
        });
      }
      const blocking = blockingFindings(findings, this.config);
      const currentBlockingHashes = new Set(blocking.map((finding) => finding.findingHash));
      const resolvedFindingHashes = [
        ...(latestState?.resolvedFindingHashes ?? []),
        ...blockingFindings(previousFindings, this.config)
          .map((finding) => finding.findingHash)
          .filter((hash) => !currentBlockingHashes.has(hash))
      ];
      const reviewerStates: ReviewStateReviewer[] = artifacts.map((entry) => ({
        name: entry.artifact.reviewer,
        decision: entry.artifact.decision,
        iteration,
        artifactPath: entry.path
      }));
      const humanRequired = artifacts.some((entry) => entry.artifact.decision === "human_required");
      const allRequiredApproved = this.config.review.requiredReviewers.every((reviewer) =>
        artifacts.some((entry) => entry.artifact.reviewer === reviewer && entry.artifact.decision === "approved")
      );
      const repeated = repeatedBlockingHashes(previousFindings, findings, this.config);
      const status: ReviewStatus = humanRequired ? "human_required" : blocking.length > 0 || !allRequiredApproved ? "changes_requested" : "approved";

      latestState = await this.recordIssueState(issue, {
        phase: "review",
        reviewIteration: iteration,
        reviewStatus: status,
        reviewers: reviewerStates,
        findings,
        resolvedFindingHashes: [...new Set(resolvedFindingHashes)],
        headSha: githubContext.status.headSha,
        lastReviewedSha: githubContext.status.headSha
      });

      await this.logger.write({
        type: status === "approved" ? "review_approved" : "review_iteration_complete",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `iteration ${iteration}: ${status}`,
        payload: { blocking: blocking.length, repeated }
      });

      if (status === "approved") {
        await this.commentIssue(
          issue,
          [
            "### AgentOS automated review approved",
            "",
            "Required Wiggum reviewers approved this PR.",
            "",
            `- PR: ${state.prUrl}`,
            `- Iteration: ${iteration}`,
            `- Reviewers: ${reviewerStates.map((reviewer) => `${reviewer.name}=${reviewer.decision}`).join(", ")}`
          ].join("\n")
        );
        return latestState;
      }

      if (humanRequired || repeated.length > 0 || iteration >= this.config.review.maxIterations) {
        const reason = humanRequired
          ? "a reviewer requested human judgment"
          : repeated.length > 0
            ? "the same blocking finding repeated after a fix"
            : "maximum review iterations reached";
        latestState = await this.recordIssueState(issue, { phase: "review", reviewStatus: "human_required", findings });
        await this.commentIssue(
          issue,
          [
            "### AgentOS automated review needs human judgment",
            "",
            `The Wiggum loop stopped because ${reason}.`,
            "",
            `- PR: ${state.prUrl}`,
            `- Iteration: ${iteration}`,
            "",
            "Blocking findings:",
            formatFindings(blocking, resolve(this.options.repoRoot))
          ].join("\n")
        );
        await this.logger.write({
          type: "review_human_required",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: reason,
          payload: { findings: blocking, repeated }
        });
        return latestState;
      }

      await this.logger.write({
        type: "review_fix_started",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `iteration ${iteration}`,
        payload: { findings: blocking }
      });
      await this.commentIssue(
        issue,
        [
          "### AgentOS automated review requested fixes",
          "",
          "Blocking findings were found. AgentOS is running a focused fix turn on the existing PR.",
          "",
          `- PR: ${state.prUrl}`,
          `- Iteration: ${iteration}`,
          "",
          formatFindings(blocking, resolve(this.options.repoRoot))
        ].join("\n")
      );
      await this.recordIssueState(issue, { phase: "fix", reviewStatus: "changes_requested" });
      const fixResult = await this.runner.run({
        issue,
        prompt: fixPrompt({
          issue,
          prUrl: state.prUrl,
          iteration,
          findings: blocking,
          handoffPath: join(workspace.path, ".agent-os", `handoff-${issue.identifier}.md`),
          feedbackSummary: githubContext.feedback
        }),
        attempt,
        workspace,
        config: this.config,
        signal,
        onEvent: (event) => void this.logger.write({ ...event, type: `review_fix_${event.type}` })
      });
      if (fixResult.status !== "succeeded") {
        latestState = await this.recordIssueState(issue, {
          phase: "fix",
          reviewStatus: "human_required",
          lastError: fixResult.error ?? fixResult.status,
          errorCategory: "fix"
        });
        await this.commentIssue(issue, `### AgentOS review fix failed\n\nThe fixer turn did not complete successfully.\n\n- PR: ${state.prUrl}\n- Error: ${fixResult.error ?? fixResult.status}`);
        return latestState;
      }
      const updatedHandoff = await readHandoff(workspace.path, issue.identifier);
      if (updatedHandoff) {
        const updated = issueStateFromHandoff(issue, updatedHandoff);
        if (updated) {
          latestState = await new IssueStateStore(resolve(this.options.repoRoot)).merge(issue.identifier, {
            ...updated,
            phase: "fix",
            reviewIteration: iteration,
            lastFixedSha: githubContext.status.headSha
          });
        }
      }
      previousFindings = findings;
    }
    return latestState;
  }

  private reviewersFor(changedFiles: string[]): string[] {
    const reviewers = [...this.config.review.requiredReviewers];
    const securityNeeded = changedFiles.some((file) => /(^|\/)(auth|security|secrets?|config|env|api|github|linear|runner|orchestrator)/i.test(file));
    for (const reviewer of this.config.review.optionalReviewers) {
      if (reviewer === "security" && !securityNeeded) continue;
      if (!reviewers.includes(reviewer)) reviewers.push(reviewer);
    }
    return reviewers;
  }

  private async githubReviewContext(prUrl: string): Promise<{ status: Awaited<ReturnType<GitHubClient["getPullRequest"]>>; summary: string; feedback: string }> {
    const github = new GitHubClient(this.config.github.command);
    const cwd = resolve(this.options.repoRoot);
    const status = await github.getPullRequest(prUrl, cwd);
    const diff = await github.getPullRequestDiff(prUrl, cwd).catch((error: Error) => `Could not fetch diff: ${error.message}`);
    const threads = await github.getPullRequestReviewThreads(prUrl, cwd).catch(() => []);
    return {
      status,
      summary: summarizePullRequestForPrompt(status, diff, threads),
      feedback: summarizeFeedback(status, threads)
    };
  }

  private async shepherdMergeIssue(issue: Issue): Promise<void> {
    const stateStore = new IssueStateStore(resolve(this.options.repoRoot));
    const state = await stateStore.read(issue.identifier);
    if (!state?.prUrl) {
      await this.markMergeFailed(issue, "No pull request metadata was found for this issue.");
      return;
    }

    await this.logger.write({
      type: "merge_shepherd_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: state.prUrl
    });

    const github = new GitHubClient(this.config.github.command);
    try {
      const pr = await github.getPullRequest(state.prUrl, resolve(this.options.repoRoot));
      if (pr.merged) {
        await this.commentIssue(issue, `### AgentOS merge shepherd\n\nPull request is already merged: ${state.prUrl}`);
        await this.moveIssue(issue, this.config.github.doneState);
        return;
      }

      if (this.config.review.enabled && state.reviewStatus !== "approved") {
        if (!this.config.github.allowHumanMergeOverride) {
          await this.markMergeFailed(issue, `automated review is not approved (reviewStatus=${state.reviewStatus ?? "missing"})`, state.prUrl);
          return;
        }
        if (!state.humanOverrideAt) {
          const overrideAt = new Date().toISOString();
          await new IssueStateStore(resolve(this.options.repoRoot)).merge(issue.identifier, {
            ...state,
            humanOverrideAt: overrideAt,
            updatedAt: overrideAt
          });
          await this.commentIssue(
            issue,
            [
              "### AgentOS review override recorded",
              "",
              "This issue is in `Merging` before automated review approval. Treating the Linear status move as explicit human approval for this merge attempt.",
              "",
              `- PR: ${state.prUrl}`,
              `- Previous reviewStatus: ${state.reviewStatus ?? "missing"}`
            ].join("\n")
          );
          await this.logger.write({
            type: "review_human_override",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: state.reviewStatus ?? "missing",
            payload: { prUrl: state.prUrl }
          });
        }
      }

      const readiness = evaluateMergeReadiness(pr, this.config.github.requireChecks);
      if (!readiness.ready) {
        if (readiness.reason.includes("pending")) {
          await this.markMergeWaiting(issue, state.prUrl, readiness.reason);
        } else {
          await this.markMergeFailed(issue, readiness.reason, state.prUrl);
        }
        return;
      }

      await this.commentIssue(issue, `### AgentOS merge shepherd\n\nChecks are green and the pull request is mergeable. Starting ${this.config.github.mergeMethod} merge.\n\n- PR: ${state.prUrl}`);
      await github.mergePullRequest(state.prUrl, this.config.github, resolve(this.options.repoRoot));
      await this.commentIssue(issue, `### AgentOS merge complete\n\nMerged successfully.\n\n- PR: ${state.prUrl}\n- Method: ${this.config.github.mergeMethod}`);
      await this.moveIssue(issue, this.config.github.doneState);
      await this.logger.write({
        type: "merge_succeeded",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: state.prUrl
      });
    } catch (error) {
      await this.markMergeFailed(issue, error instanceof Error ? error.message : String(error), state.prUrl);
    }
  }

  private isEligible(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    if (this.retries.has(issue.id) && this.retries.get(issue.id)!.dueAtMs > Date.now()) return false;
    if (this.completedMarkers.get(issue.id) === completionMarker(issue)) return false;
    const state = issue.state.toLowerCase();
    if (!this.config.tracker.activeStates.map((item) => item.toLowerCase()).includes(state)) return false;
    if (this.config.tracker.terminalStates.map((item) => item.toLowerCase()).includes(state)) return false;
    if (state === "todo") {
      return issue.blocked_by.every((blocker) => {
        const blockerState = (blocker.state ?? "").toLowerCase();
        return this.config.tracker.terminalStates.map((item) => item.toLowerCase()).includes(blockerState);
      });
    }
    return true;
  }

  private hasSlot(state: string): boolean {
    if (this.running.size >= this.config.agent.maxConcurrentAgents) return false;
    const stateLimit = this.config.agent.maxConcurrentAgentsByState.get(state.toLowerCase());
    if (!stateLimit) return true;
    const runningInState = [...this.running.values()].filter((entry) => entry.issue.state.toLowerCase() === state.toLowerCase()).length;
    return runningInState < stateLimit;
  }

  private async handleFailedRun(issue: Issue, workspace: Workspace, previousAttempt: number | null, error: string): Promise<void> {
    const nextAttempt = previousAttempt == null ? 1 : previousAttempt + 1;
    if (nextAttempt > this.config.agent.maxRetryAttempts) {
      await this.recordIssueState(issue, {
        lastError: error,
        errorCategory: categorizeRunError(error)
      });
      await this.markLinearFailed(issue, workspace, previousAttempt, error);
      return;
    }
    const retry = this.scheduleRetry(issue, previousAttempt, error);
    await this.recordIssueState(issue, {
      lastError: error,
      errorCategory: categorizeRunError(error),
      nextRetryAt: new Date(retry.dueAtMs).toISOString()
    });
    await this.markLinearRetryScheduled(issue, workspace, retry);
  }

  private scheduleRetry(issue: Issue, previousAttempt: number | null, error: string | null, overrideDelayMs?: number): RetryEntry {
    const attempt = previousAttempt == null ? 1 : previousAttempt + 1;
    const delay = overrideDelayMs ?? Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), this.config.agent.maxRetryBackoffMs);
    const retry = {
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt,
      dueAtMs: Date.now() + delay,
      error
    };
    this.retries.set(issue.id, retry);
    return retry;
  }

  private async markLinearStarted(issue: Issue, workspace: Workspace, attempt: number | null): Promise<void> {
    await this.moveIssue(issue, this.config.tracker.runningState);
    await this.commentIssue(
      issue,
      [
        "### AgentOS started",
        "",
        "The Symphony loop picked up this issue and started a Codex run.",
        "",
        `- Attempt: ${displayAttempt(attempt)}`,
        `- Workspace: \`${workspace.path}\``,
        `- Branch: \`agent/${workspace.workspaceKey}\``,
        "- Logs: `.agent-os/runs/agent-os.jsonl`"
      ].join("\n"),
      "run_started"
    );
  }

  private async markLinearSucceeded(issue: Issue, workspace: Workspace, handoff: string | null, state?: IssueState): Promise<void> {
    await this.recordIssueState(issue, { phase: "completed" });
    const reviewLine = state?.reviewStatus
      ? `\n\nAutomated review status: \`${state.reviewStatus}\`${state.reviewIteration ? ` after iteration ${state.reviewIteration}` : ""}.`
      : "";
    await this.commentIssue(
      issue,
      handoff
        ? `${handoff}${reviewLine}`
        : [
            "### AgentOS handoff",
            "",
            "Codex completed this run successfully, but no handoff file was found.",
            "",
            `- Workspace: \`${workspace.path}\``,
            "- Expected validation: project harness check",
            reviewLine.trim()
          ].join("\n"),
      "run_handoff"
    );
    await this.moveIssue(issue, this.config.tracker.reviewState);
  }

  private async markLinearRetryScheduled(issue: Issue, workspace: Workspace, retry: RetryEntry): Promise<void> {
    await this.commentIssue(
      issue,
      [
        "### AgentOS retry scheduled",
        "",
        "Codex did not complete the run successfully. The Symphony loop will retry automatically.",
        "",
        `- Next retry: ${retry.attempt} of ${this.config.agent.maxRetryAttempts}`,
        `- Retry after: ${new Date(retry.dueAtMs).toISOString()}`,
        `- Workspace: \`${workspace.path}\``,
        `- Error: ${retry.error ?? "unknown"}`
      ].join("\n"),
      "retry_scheduled"
    );
  }

  private async markLinearFailed(issue: Issue, workspace: Workspace, attempt: number | null, error: string): Promise<void> {
    await this.commentIssue(
      issue,
      [
        "### AgentOS needs human input",
        "",
        "Codex could not complete this issue within the configured retry budget.",
        "",
        `- Last attempt: ${displayAttempt(attempt)}`,
        `- Workspace: \`${workspace.path}\``,
        `- Error: ${error}`,
        "",
        "Please adjust the issue, repo, or workflow instructions before returning it to an active state."
      ].join("\n"),
      "run_failed"
    );
    await this.moveIssue(issue, this.config.tracker.needsInputState);
  }

  private async markMergeWaiting(issue: Issue, prUrl: string, reason: string): Promise<void> {
    const marker = `${issue.updated_at ?? ""}:${reason}`;
    if (this.mergeWaitingMarkers.get(issue.id) === marker) return;
    this.mergeWaitingMarkers.set(issue.id, marker);
    await this.commentIssue(
      issue,
      [
        "### AgentOS merge waiting",
        "",
        "The issue is in `Merging`, but the pull request is not ready yet.",
        "",
        `- PR: ${prUrl}`,
        `- Reason: ${reason}`
      ].join("\n"),
      "merge_waiting"
    );
    await this.logger.write({
      type: "merge_waiting",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { prUrl }
    });
  }

  private async markMergeFailed(issue: Issue, reason: string, prUrl?: string): Promise<void> {
    await this.commentIssue(
      issue,
      [
        "### AgentOS merge needs human review",
        "",
        "The merge shepherd could not safely merge this issue.",
        "",
        prUrl ? `- PR: ${prUrl}` : null,
        `- Reason: ${reason}`,
        "",
        "Please resolve the issue and move it back to `Merging` when ready."
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      "merge_failed"
    );
    await this.moveIssue(issue, this.config.tracker.reviewState);
    await this.logger.write({
      type: "merge_failed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { prUrl }
    });
  }

  private async recordIssueState(issue: Issue, patch: Partial<IssueState>): Promise<IssueState> {
    return new IssueStateStore(resolve(this.options.repoRoot)).merge(issue.identifier, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      ...patch
    });
  }

  private async moveIssue(issue: Issue, stateName: string | null): Promise<void> {
    if (!stateName || !this.tracker.move) return;
    await this.tracker.move(issue.identifier, stateName).catch((error: Error) =>
      this.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `move to ${stateName}: ${error.message}`
      })
    );
  }

  private async commentIssue(issue: Issue, body: string, key?: string): Promise<void> {
    if (!this.tracker.comment && !this.tracker.upsertComment) return;
    const safeBody = redactText(key ? `${linearCommentMarker(key, issue.identifier)}\n${body}` : body);
    const operation =
      key && this.tracker.upsertComment
        ? this.tracker.upsertComment(issue.identifier, safeBody, linearCommentKey(key, issue.identifier))
        : this.tracker.comment!(issue.identifier, safeBody);
    await operation.catch((error: Error) =>
      this.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `comment: ${error.message}`
      })
    );
  }
}

function linearCommentKey(event: string, issueIdentifier: string): string {
  return `${event}:${issueIdentifier}`;
}

function linearCommentMarker(event: string, issueIdentifier: string): string {
  return `<!-- agentos:event=${linearCommentKey(event, issueIdentifier)} -->`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true }
    );
  });
}

function completionMarker(issue: Issue): string {
  return issue.updated_at ?? `${issue.state}:${issue.title}`;
}

function displayAttempt(attempt: number | null): number {
  return (attempt ?? 0) + 1;
}

function isStateIn(state: string, states: string[]): boolean {
  const normalized = state.toLowerCase();
  return states.map((item) => item.toLowerCase()).includes(normalized);
}

function runningAllowedStates(config: ServiceConfig): string[] {
  return [...config.tracker.activeStates, config.tracker.runningState].filter((state): state is string => Boolean(state));
}

function readOnlyReviewConfig(config: ServiceConfig, repoRoot: string): ServiceConfig {
  return {
    ...config,
    codex: {
      ...config.codex,
      threadSandbox: config.codex.threadSandbox ?? "workspace-write",
      turnSandboxPolicy: config.codex.turnSandboxPolicy ?? { type: "workspaceWrite", writableRoots: [config.workspace.root, join(repoRoot, ".agent-os", "reviews")], networkAccess: true }
    }
  };
}

function reviewCheckFindings(status: Awaited<ReturnType<GitHubClient["getPullRequest"]>>, config: ServiceConfig): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (status.checkSummary.failing > 0) {
    findings.push({
      reviewer: "checks",
      decision: "changes_requested" as const,
      severity: "P1" as const,
      file: null,
      line: null,
      body: `${status.checkSummary.failing} GitHub check(s) failed. Fix CI before Human Review.`,
      findingHash: `checks-failing-${status.checkSummary.failing}`
    });
  }
  if (config.github.requireChecks && status.checkSummary.total === 0) {
    findings.push({
      reviewer: "checks",
      decision: "changes_requested" as const,
      severity: "P1" as const,
      file: null,
      line: null,
      body: "No GitHub checks are present. The Wiggum loop requires at least one successful check or a human escalation.",
      findingHash: "checks-missing"
    });
  }
  if (config.github.requireChecks && status.checkSummary.total > 0 && status.checkSummary.successful === 0 && status.checkSummary.pending === 0) {
    findings.push({
      reviewer: "checks",
      decision: "changes_requested" as const,
      severity: "P1" as const,
      file: null,
      line: null,
      body: "No successful GitHub checks are present.",
      findingHash: "checks-no-success"
    });
  }
  return findings;
}

function categorizeRunError(message: string): RunErrorCategory {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("stall")) return "stall";
  if (normalized.includes("cancel")) return "canceled";
  if (normalized.includes("workspace") || normalized.includes("worktree")) return "workspace";
  if (normalized.includes("prompt") || normalized.includes("liquid")) return "prompt";
  if (normalized.includes("app_server") || normalized.includes("app-server") || normalized.includes("initialize")) return "app-server-init";
  if (normalized.includes("review")) return "review";
  if (normalized.includes("fix")) return "fix";
  if (normalized.includes("validation") || normalized.includes("test") || normalized.includes("check")) return "validation";
  return "streaming-turn";
}

async function readHandoff(workspacePath: string, identifier: string): Promise<string | null> {
  const path = join(workspacePath, ".agent-os", `handoff-${identifier}.md`);
  if (!(await exists(path))) return null;
  const text = await readText(path);
  return text.trim() ? text : null;
}
