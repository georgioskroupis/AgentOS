import type { MonitorChangedSurface, MonitorEvent, MonitorHumanActionReasonCode } from "./monitor-contracts.js";
import type { HumanAction, MonitorSnapshot } from "./monitor-extension-contracts.js";

type SnapshotRun = NonNullable<MonitorSnapshot["run"]>;

export type MonitorTextRunContext = {
  runId: string;
  issue: SnapshotRun["issue"];
  summary?: Partial<SnapshotRun["summary"]>;
  changedFiles?: string[];
  changedSurfaces?: MonitorChangedSurface[];
  humanAction?: {
    reasonCode?: MonitorHumanActionReasonCode;
    changedFiles?: string[];
    changedSurfaces?: MonitorChangedSurface[];
    details?: string;
  };
};

export type StoredMonitorTextEvent = {
  event: MonitorEvent;
};

export type GeneratedMonitorText = {
  key: string;
  summary: SnapshotRun["summary"];
  humanAction: HumanAction;
};

type HumanActionFacts = {
  reasonCode: MonitorHumanActionReasonCode;
  changedSurfaces: MonitorChangedSurface[];
  details?: string;
};

export const fallbackMonitorSummary: SnapshotRun["summary"] = {
  why: "Why is not available yet.",
  build: "Changed surface is not known yet.",
  done: "Run state is not available yet."
};

const notNeededHumanAction: HumanAction = {
  required: false,
  stoppedBecause: "Not needed",
  youShould: "Not needed",
  manualTest: "Not needed",
  expectedResult: "Not needed",
  recommendedNextStep: "Not needed"
};

export function monitorGeneratedText(input: {
  run: MonitorTextRunContext;
  status: MonitorSnapshot["status"];
  terminalEvent?: MonitorEvent;
  humanActionEvent?: MonitorEvent;
  orderedEvents: StoredMonitorTextEvent[];
}): GeneratedMonitorText {
  const surfaces = changedSurfaces(input.run, input.humanActionEvent);
  const facts = humanActionFacts(input.run, input.status, input.terminalEvent, input.humanActionEvent, surfaces);
  return {
    key: generatedTextCacheKey(input.run, input.status, input.terminalEvent, input.humanActionEvent, input.orderedEvents),
    summary: generatedSummary(input.run, input.status, input.terminalEvent, surfaces, input.orderedEvents),
    humanAction: generatedHumanAction(facts)
  };
}

function generatedSummary(
  run: MonitorTextRunContext,
  status: MonitorSnapshot["status"],
  terminalEvent: MonitorEvent | undefined,
  surfaces: MonitorChangedSurface[],
  orderedEvents: StoredMonitorTextEvent[]
): SnapshotRun["summary"] {
  const issueTitle = cleanText(run.issue.title);
  const issueId = cleanText(run.issue.id);
  const why = issueTitle ? `Work on ${issueId ? `${issueId}: ` : ""}${issueTitle}` : fallbackMonitorSummary.why;
  const build = buildSummary(surfaces);
  const lastEvent = orderedEvents.at(-1)?.event;
  const terminalResult = cleanText(terminalEvent?.result);
  const done =
    status === "completed"
      ? terminalResult
        ? `Completed: ${terminalResult}`
        : "Run completed."
      : status === "failed"
        ? terminalResult
          ? `Stopped: ${terminalResult}`
          : "Run stopped before completion."
        : status === "human_action"
          ? "Waiting for a human action."
          : lastEvent?.label
            ? `Current step: ${lastEvent.label}`
            : fallbackMonitorSummary.done;
  return { why, build, done };
}

function buildSummary(surfaces: MonitorChangedSurface[]): string {
  if (isDocsOnly(surfaces)) return "Docs-only changes are in scope.";
  if (surfaces.includes("workflow-config")) return "Workflow/config behavior is in scope.";
  if (surfaces.includes("architecture-check")) return "Architecture-check behavior is in scope.";
  if (surfaces.includes("ui")) return "UI behavior is in scope.";
  if (surfaces.includes("tests")) return "Test coverage is in scope.";
  if (surfaces.includes("source")) return "Source behavior is in scope.";
  return fallbackMonitorSummary.build;
}

function generatedHumanAction(facts: HumanActionFacts): HumanAction {
  if (facts.reasonCode === "none") return notNeededHumanAction;
  const surface = primarySurface(facts.changedSurfaces);
  return {
    required: true,
    stoppedBecause: stoppedBecause(facts),
    youShould: youShould(facts.reasonCode, surface),
    manualTest: manualTest(surface),
    expectedResult: expectedResult(surface),
    recommendedNextStep: recommendedNextStep(facts.reasonCode)
  };
}

function humanActionFacts(
  run: MonitorTextRunContext,
  status: MonitorSnapshot["status"],
  terminalEvent: MonitorEvent | undefined,
  humanActionEvent: MonitorEvent | undefined,
  surfaces: MonitorChangedSurface[]
): HumanActionFacts {
  const reasonCode = run.humanAction?.reasonCode ?? humanActionEvent?.humanAction?.reasonCode ?? inferReasonCode(status, terminalEvent, humanActionEvent);
  const details = cleanText(run.humanAction?.details ?? humanActionEvent?.humanAction?.details ?? terminalEvent?.result ?? humanActionEvent?.result ?? humanActionEvent?.label);
  return {
    reasonCode,
    changedSurfaces: surfaces,
    ...(details ? { details } : {})
  };
}

function inferReasonCode(status: MonitorSnapshot["status"], terminalEvent: MonitorEvent | undefined, humanActionEvent: MonitorEvent | undefined): MonitorHumanActionReasonCode {
  if (humanActionEvent) return "needs_input";
  if (status !== "failed") return "none";
  if (terminalEvent?.validation?.status === "fail") return "validation_failed";
  const text = `${terminalEvent?.label ?? ""} ${terminalEvent?.result ?? ""}`.toLowerCase();
  if (text.includes("architecture")) return "architecture_check_failed";
  if (text.includes("ci") || text.includes("check")) return "ci_failed";
  if (text.includes("review")) return "review_findings";
  if (text.includes("validation")) return "validation_failed";
  return "unknown";
}

function stoppedBecause(facts: HumanActionFacts): string {
  if (facts.details) return facts.details;
  const labels: Record<MonitorHumanActionReasonCode, string> = {
    none: "Not needed",
    validation_failed: "Stopped because validation failed.",
    ci_failed: "Stopped because CI or required checks need attention.",
    review_findings: "Stopped because automated review findings need attention.",
    architecture_check_failed: "Stopped because the architecture check needs attention.",
    workflow_config_changed: "Stopped because workflow/config changes need human confirmation.",
    human_review: "Stopped for human review.",
    needs_input: "Stopped because human input is required.",
    planning_required: "Stopped because planning or decomposition is required.",
    recovery_needed: "Stopped because existing workspace work needs recovery.",
    blocked: "Stopped because the run is blocked.",
    capacity_wait: "Stopped because capacity is unavailable until a later retry.",
    unknown: "Stopped because the monitor does not have a specific reason code."
  };
  return labels[facts.reasonCode];
}

function youShould(reasonCode: MonitorHumanActionReasonCode, surface: MonitorChangedSurface): string {
  if (surface === "workflow-config") return "Review workflow/config changes before continuing.";
  if (surface === "architecture-check") return "Inspect the architecture check output and the affected boundary.";
  if (surface === "ui") return "Inspect the monitor UI and compare it with the intended state.";
  if (surface === "docs") return "Review the docs diff and confirm the wording is correct.";
  if (reasonCode === "validation_failed") return "Inspect the failing validation output.";
  if (reasonCode === "review_findings") return "Resolve or explicitly accept the blocking review findings.";
  if (reasonCode === "planning_required") return "Create or attach a bounded planning/decomposition artifact before continuing.";
  if (reasonCode === "recovery_needed") return "Resume the existing workspace, preserve its changes, validate, then record recovery.";
  return "Review the latest run evidence before continuing.";
}

function manualTest(surface: MonitorChangedSurface): string {
  if (surface === "architecture-check") return "Run npm run check:architecture.";
  if (surface === "workflow-config") return "Run the affected workflow/config check or inspect the policy path manually.";
  if (surface === "ui") return "Open the monitor UI and verify the changed view renders correctly.";
  if (surface === "docs") return "Manual test could not be inferred from docs-only changes.";
  return "Manual test could not be inferred from the available monitor data.";
}

function expectedResult(surface: MonitorChangedSurface): string {
  if (surface === "architecture-check") return "Architecture validation passes or reports only accepted findings.";
  if (surface === "workflow-config") return "Workflow/config behavior matches the intended policy.";
  if (surface === "ui") return "The monitor UI renders the changed state without layout or data regressions.";
  if (surface === "docs") return "Docs accurately describe the implemented behavior.";
  return "Expected result could not be inferred from the available monitor data.";
}

function recommendedNextStep(reasonCode: MonitorHumanActionReasonCode): string {
  const nextSteps: Record<MonitorHumanActionReasonCode, string> = {
    none: "Not needed",
    validation_failed: "Fix the failing validation, rerun the check, then update validation evidence.",
    ci_failed: "Inspect the failed check logs, repair the mechanical failure, then wait for fresh checks.",
    review_findings: "Address the blocking findings or record an accepted-risk decision.",
    architecture_check_failed: "Align the architecture boundary or update the contract, then rerun the architecture check.",
    workflow_config_changed: "Confirm the workflow policy change, then rerun the affected validation.",
    human_review: "Record the supervisor decision and continue through the configured lifecycle.",
    needs_input: "Record the requested human input, then continue the run from the latest evidence.",
    planning_required: "Add a bounded Active Scope or split follow-up issues, then return the issue to an active state.",
    recovery_needed: "Commit or push the recovered workspace evidence, then run the documented recovery command.",
    blocked: "Clear the blocker or split follow-up work before continuing.",
    capacity_wait: "Wait for capacity to recover, then retry without changing source state.",
    unknown: "Decide the next action from validation, handoff, and PR evidence."
  };
  return nextSteps[reasonCode];
}

function changedSurfaces(run: MonitorTextRunContext, event: MonitorEvent | undefined): MonitorChangedSurface[] {
  const explicit = uniqueSurfaces([...(run.changedSurfaces ?? []), ...(run.humanAction?.changedSurfaces ?? []), ...(event?.humanAction?.changedSurfaces ?? [])]);
  const fromFiles = surfacesFromFiles([...(run.changedFiles ?? []), ...(run.humanAction?.changedFiles ?? []), ...(event?.humanAction?.changedFiles ?? [])]);
  const surfaces = uniqueSurfaces([...explicit, ...fromFiles]);
  return surfaces.length > 0 ? surfaces : ["unknown"];
}

function surfacesFromFiles(files: string[]): MonitorChangedSurface[] {
  return uniqueSurfaces(files.map(surfaceFromFile));
}

function surfaceFromFile(file: string): MonitorChangedSurface {
  const normalized = file.replace(/\\/g, "/");
  if (/^(WORKFLOW\.md|AGENTS\.md|agent-os\.ya?ml|\.github\/|scripts\/agent-|templates\/base-harness\/WORKFLOW\.md)/.test(normalized)) return "workflow-config";
  if (/^(ARCHITECTURE\.md|docs\/architecture\/|scripts\/check-architecture\.mjs)/.test(normalized)) return "architecture-check";
  if (/^(dashboard\/|src\/http-server|src\/monitor-|tests\/dashboard-profiler-ui)/.test(normalized) || /\.(css|html)$/.test(normalized)) return "ui";
  if (/^(docs|templates\/base-harness\/docs|templates\/profiles\/[^/]+\/docs)\//.test(normalized) || /\.(md|mdx)$/.test(normalized)) return "docs";
  if (/^(tests\/|test\/)/.test(normalized) || /\.(test|spec)\.[cm]?[jt]s$/.test(normalized)) return "tests";
  if (/^(src\/|bin\/)/.test(normalized) || /\.[cm]?[jt]s$/.test(normalized)) return "source";
  return "unknown";
}

function primarySurface(surfaces: MonitorChangedSurface[]): MonitorChangedSurface {
  for (const surface of ["architecture-check", "workflow-config", "ui", "docs", "tests", "source"] as const) {
    if (surfaces.includes(surface)) return surface;
  }
  return "unknown";
}

function isDocsOnly(surfaces: MonitorChangedSurface[]): boolean {
  return surfaces.length > 0 && surfaces.every((surface) => surface === "docs");
}

function uniqueSurfaces(surfaces: MonitorChangedSurface[]): MonitorChangedSurface[] {
  return [...new Set(surfaces)];
}

function generatedTextCacheKey(
  run: MonitorTextRunContext,
  status: MonitorSnapshot["status"],
  terminalEvent: MonitorEvent | undefined,
  humanActionEvent: MonitorEvent | undefined,
  orderedEvents: StoredMonitorTextEvent[]
): string {
  return JSON.stringify({
    runId: run.runId,
    issue: run.issue,
    status,
    summary: run.summary,
    changedFiles: run.changedFiles,
    changedSurfaces: run.changedSurfaces,
    runHumanAction: run.humanAction,
    terminal: terminalEvent ? eventTextFacts(terminalEvent) : null,
    humanAction: humanActionEvent ? eventTextFacts(humanActionEvent) : null,
    lastEvent: orderedEvents.at(-1)?.event.eventId ?? null,
    eventCount: orderedEvents.length
  });
}

function eventTextFacts(event: MonitorEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    kind: event.kind,
    label: event.label,
    result: event.result,
    validation: event.validation,
    humanAction: event.humanAction
  };
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
