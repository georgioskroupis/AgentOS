import type { MonitorEvent, MonitorSink, MonitorStatus, MonitorTimeClass } from "./monitor-contracts.js";
import type { HumanAction, MonitorSnapshot, TimeSink, TimingRow } from "./monitor-extension-contracts.js";

type SnapshotRun = NonNullable<MonitorSnapshot["run"]>;

export type MonitorRunContext = {
  runId: string;
  issue: SnapshotRun["issue"];
  attempt: SnapshotRun["attempt"];
  links?: Partial<SnapshotRun["links"]>;
  summary?: Partial<SnapshotRun["summary"]>;
  currentModel?: string;
};

export type MonitorSnapshotOptions = {
  serverNow?: string;
  run?: MonitorRunContext;
  topTimeSinkLimit?: number;
};

export type MonitorAggregatorRetention = {
  activeRunId?: string;
  activeEventCount: number;
  hasTerminalSnapshot: boolean;
};

export type MonitorSnapshotListener = (snapshot: MonitorSnapshot) => void;

type StoredMonitorEvent = {
  event: MonitorEvent;
  order: number;
};

type SpanState = {
  id: string;
  label: string;
  status: MonitorStatus;
  timeClass: MonitorTimeClass;
  startedAt: string;
  startedMs: number;
  endedAt?: string;
  endedMs?: number;
  parentSpanId?: string;
  model?: string;
  iteration?: string;
  result?: string;
  kind: MonitorEvent["kind"];
  order: number;
};

type BuiltRow = {
  row: TimingRow;
  order: number;
  startedMs: number;
};

const defaultSummary: SnapshotRun["summary"] = {
  why: "Monitor snapshot",
  build: "In-memory monitor reducer",
  done: "Run is still active"
};

const notNeededHumanAction: HumanAction = {
  required: false,
  stoppedBecause: "Not needed",
  youShould: "Not needed",
  manualTest: "Not needed",
  expectedResult: "Not needed",
  recommendedNextStep: "Not needed"
};

export class InMemoryMonitorAggregator implements MonitorSink {
  private activeRunId: string | undefined;
  private currentRun: MonitorRunContext | undefined;
  private events: StoredMonitorEvent[] = [];
  private terminalSnapshot: MonitorSnapshot | undefined;
  private listeners = new Set<MonitorSnapshotListener>();
  private sequence = 0;

  emit(event: MonitorEvent): void {
    if (event.kind === "run_started" && this.activeRunId !== event.runId) {
      this.activeRunId = event.runId;
      this.events = [];
    }

    if (!this.activeRunId) this.activeRunId = event.runId;
    if (event.runId !== this.activeRunId) return;
    this.ensureRunContext(event);

    this.events.push({ event, order: this.sequence++ });

    if (isTerminalKind(event.kind) && this.currentRun?.runId === event.runId) {
      const snapshot = this.buildSnapshot(event.timestamp, this.currentRun);
      this.retainTerminal(snapshot);
      this.notify(snapshot);
      return;
    }
    this.notify(this.snapshot({ serverNow: event.timestamp }));
  }

  updateRunContext(run: MonitorRunContext): void {
    this.currentRun = run;
    if (!this.activeRunId) this.activeRunId = run.runId;
    this.notify(this.snapshot());
  }

  snapshot(options: MonitorSnapshotOptions = {}): MonitorSnapshot {
    const serverNow = options.serverNow ?? new Date().toISOString();
    if (options.run) this.updateRunContext(options.run);

    if (!this.activeRunId || !this.currentRun || this.currentRun.runId !== this.activeRunId) {
      return this.terminalSnapshot ?? { serverNow, status: "idle" };
    }

    const snapshot = this.buildSnapshot(serverNow, this.currentRun, options.topTimeSinkLimit);
    if (snapshot.status === "completed" || snapshot.status === "failed") {
      this.retainTerminal(snapshot);
    }
    return snapshot;
  }

  retention(): MonitorAggregatorRetention {
    return {
      ...(this.activeRunId ? { activeRunId: this.activeRunId } : {}),
      activeEventCount: this.events.length,
      hasTerminalSnapshot: this.terminalSnapshot != null
    };
  }

  subscribe(listener: MonitorSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private ensureRunContext(event: MonitorEvent): void {
    if (this.currentRun?.runId === event.runId) return;
    this.currentRun = {
      runId: event.runId,
      issue: { id: event.issueId ?? event.runId, title: event.label },
      attempt: { current: 0 },
      links: {},
      summary: defaultSummary
    };
  }

  private notify(snapshot: MonitorSnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }

  private retainTerminal(snapshot: MonitorSnapshot): void {
    this.terminalSnapshot = snapshot;
    this.activeRunId = undefined;
    this.currentRun = undefined;
    this.events = [];
  }

  private buildSnapshot(serverNow: string, run: MonitorRunContext, topTimeSinkLimit = 5): MonitorSnapshot {
    const serverNowMs = timestampMs(serverNow);
    const orderedEvents = this.events.filter((stored) => stored.event.runId === run.runId).sort(compareStoredEvents);
    const spans = new Map<string, SpanState>();
    let firstEventMs = serverNowMs;
    let firstEventAt = serverNow;
    let lastEventMs = serverNowMs;
    let terminalEvent: MonitorEvent | undefined;
    let humanActionEvent: MonitorEvent | undefined;
    let currentModel = run.currentModel;

    for (const stored of orderedEvents) {
      const event = stored.event;
      const eventMs = timestampMs(event.timestamp);
      if (stored === orderedEvents[0]) {
        firstEventMs = eventMs;
        firstEventAt = event.timestamp;
      }
      lastEventMs = eventMs;
      if (event.model?.name) currentModel = event.model.name;
      if (event.kind === "human_action_required") humanActionEvent = event;

      if (isStartKind(event.kind) && !spans.has(event.spanId)) {
        spans.set(event.spanId, {
          id: event.spanId,
          label: event.label,
          status: event.status ?? "active",
          timeClass: event.timeClass ?? defaultTimeClass(event.kind),
          startedAt: event.timestamp,
          startedMs: eventMs,
          ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
          ...(event.model?.name ? { model: event.model.name } : {}),
          ...(event.iteration ? { iteration: formatIteration(event.iteration) } : {}),
          ...(event.result ? { result: event.result } : {}),
          kind: event.kind,
          order: stored.order
        });
      }

      if (isFinishKind(event.kind)) {
        const span = spans.get(event.spanId);
        if (span && span.endedAt == null) closeSpan(span, event);
      }

      if (isTerminalKind(event.kind)) {
        terminalEvent = event;
        for (const span of spans.values()) {
          if (span.endedAt == null) closeSpan(span, event);
        }
      }
    }

    const roots = buildTimingRows(spans, serverNow, serverNowMs);
    const flatRows = flattenRows(roots.map((root) => root.row));
    const runRow = spans.get(`${run.runId}:run`) ?? [...spans.values()].find((span) => span.kind === "run_started");
    const runElapsedMs = runRow ? rowDurationMs(runRow, serverNowMs) : Math.max(0, serverNowMs - firstEventMs);
    const activeSpans = [...spans.values()].filter((span) => span.endedAt == null).sort(compareSpans);
    const activity = currentActivity(activeSpans, serverNowMs, lastEventMs, terminalEvent, currentModel);
    const status = snapshotStatus(terminalEvent, humanActionEvent, activeSpans);
    const summary = { ...defaultSummary, ...run.summary };

    if (status === "completed") summary.done = terminalEvent?.result ?? "Run completed";
    if (status === "failed") summary.done = terminalEvent?.result ?? "Run failed";

    return {
      serverNow,
      status,
      run: {
        runId: run.runId,
        issue: run.issue,
        attempt: run.attempt,
        runElapsedMs,
        ...(currentModel ? { currentModel } : {}),
        links: { ...run.links },
        summary,
        currentActivity: activity,
        timing: roots.map((root) => root.row),
        topTimeSinks: topTimeSinks(flatRows, spans, topTimeSinkLimit),
        humanAction: humanAction(humanActionEvent)
      }
    };
  }
}

function buildTimingRows(spans: Map<string, SpanState>, serverNow: string, serverNowMs: number): BuiltRow[] {
  const childIds = new Map<string, SpanState[]>();
  const roots: SpanState[] = [];
  for (const span of spans.values()) {
    if (span.parentSpanId && spans.has(span.parentSpanId)) {
      const children = childIds.get(span.parentSpanId) ?? [];
      children.push(span);
      childIds.set(span.parentSpanId, children);
    } else {
      roots.push(span);
    }
  }

  const build = (span: SpanState): BuiltRow => {
    const children = (childIds.get(span.id) ?? []).sort(compareSpans).map(build);
    const durationMs = rowDurationMs(span, serverNowMs);
    const childDurationMs = children.reduce((total, child) => total + child.row.durationMs, 0);
    const selfMs = Math.max(0, durationMs - childDurationMs);
    const waitMs = (isWaitClass(span.timeClass) ? selfMs : 0) + children.reduce((total, child) => total + child.row.waitMs, 0);
    return {
      order: span.order,
      startedMs: span.startedMs,
      row: {
        id: span.id,
        label: span.label,
        status: span.status,
        timeClass: span.timeClass,
        startedAt: span.startedAt,
        ...(span.endedAt ? { endedAt: span.endedAt } : {}),
        durationMs,
        selfMs,
        waitMs,
        ...(span.model ? { model: span.model } : {}),
        ...(span.iteration ? { iteration: span.iteration } : {}),
        ...(span.result ? { result: span.result } : {}),
        children: children.map((child) => child.row)
      }
    };
  };

  return roots.sort(compareSpans).map(build);
}

function currentActivity(
  activeSpans: SpanState[],
  serverNowMs: number,
  lastEventMs: number,
  terminalEvent: MonitorEvent | undefined,
  currentModel: string | undefined
): SnapshotRun["currentActivity"] {
  const current = activeSpans.at(-1);
  if (!current) {
    return {
      stage: terminalEvent?.kind === "run_failed" ? "Failed" : "Completed",
      step: terminalEvent?.label ?? "No active run",
      stepElapsedMs: 0,
      lastEventAgeMs: Math.max(0, serverNowMs - lastEventMs),
      ...(currentModel ? { model: currentModel } : {})
    };
  }

  const stage = [...activeSpans].reverse().find((span) => span.kind === "stage_started" || span.kind === "run_started");
  const loop = [...activeSpans].reverse().find((span) => span.kind === "loop_started" || span.kind === "loop_iteration_started");
  return {
    stage: stage?.label ?? current.label,
    step: current.label,
    ...(loop ? { loop: loop.label } : {}),
    ...(current.iteration ? { iteration: current.iteration } : {}),
    stepElapsedMs: rowDurationMs(current, serverNowMs),
    ...(loop ? { loopElapsedMs: rowDurationMs(loop, serverNowMs) } : {}),
    lastEventAgeMs: Math.max(0, serverNowMs - lastEventMs),
    ...(current.model ?? currentModel ? { model: current.model ?? currentModel } : {})
  };
}

function topTimeSinks(rows: TimingRow[], spans: Map<string, SpanState>, limit: number): TimeSink[] {
  return [...rows]
    .sort((left, right) => {
      if (right.selfMs !== left.selfMs) return right.selfMs - left.selfMs;
      const leftSpan = spans.get(left.id);
      const rightSpan = spans.get(right.id);
      return compareSpans(leftSpan, rightSpan);
    })
    .slice(0, Math.max(0, limit))
    .map((row) => ({
      id: row.id,
      label: row.label,
      selfMs: row.selfMs,
      timeClass: row.timeClass,
      ...(row.model ? { model: row.model } : {}),
      ...(row.result ? { result: row.result } : {})
    }));
}

function flattenRows(rows: TimingRow[]): TimingRow[] {
  return rows.flatMap((row) => [row, ...flattenRows(row.children)]);
}

function snapshotStatus(terminalEvent: MonitorEvent | undefined, humanActionEvent: MonitorEvent | undefined, activeSpans: SpanState[]): MonitorSnapshot["status"] {
  if (terminalEvent?.kind === "run_failed") return "failed";
  if (terminalEvent?.kind === "run_finished") return "completed";
  if (humanActionEvent) return "human_action";
  if (activeSpans.some((span) => isWaitClass(span.timeClass) || span.status === "waiting")) return "waiting";
  return activeSpans.length > 0 ? "active" : "idle";
}

function humanAction(event: MonitorEvent | undefined): HumanAction {
  if (!event) return notNeededHumanAction;
  return {
    required: true,
    stoppedBecause: event.result ?? event.label,
    youShould: event.label,
    manualTest: event.result ?? event.label,
    expectedResult: event.result ?? event.label,
    recommendedNextStep: event.label
  };
}

function closeSpan(span: SpanState, event: MonitorEvent): void {
  span.endedAt = event.timestamp;
  span.endedMs = timestampMs(event.timestamp);
  span.status = event.status ?? (event.kind === "run_failed" ? "failed" : "done");
  if (event.result) span.result = event.result;
}

function rowDurationMs(span: SpanState, serverNowMs: number): number {
  return Math.max(0, (span.endedMs ?? serverNowMs) - span.startedMs);
}

function compareStoredEvents(left: StoredMonitorEvent, right: StoredMonitorEvent): number {
  const timeDelta = timestampMs(left.event.timestamp) - timestampMs(right.event.timestamp);
  return timeDelta === 0 ? left.order - right.order : timeDelta;
}

function compareSpans(left: SpanState | undefined, right: SpanState | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const timeDelta = left.startedMs - right.startedMs;
  return timeDelta === 0 ? left.order - right.order : timeDelta;
}

function timestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatIteration(iteration: NonNullable<MonitorEvent["iteration"]>): string {
  return iteration.max == null ? `${iteration.label} ${iteration.current}` : `${iteration.label} ${iteration.current}/${iteration.max}`;
}

function isWaitClass(timeClass: MonitorTimeClass): boolean {
  return timeClass === "external-wait" || timeClass === "human-wait";
}

function isStartKind(kind: MonitorEvent["kind"]): boolean {
  return kind.endsWith("_started");
}

function isFinishKind(kind: MonitorEvent["kind"]): boolean {
  return kind.endsWith("_finished") || isTerminalKind(kind);
}

function isTerminalKind(kind: MonitorEvent["kind"]): boolean {
  return kind === "run_finished" || kind === "run_failed";
}

function defaultTimeClass(kind: MonitorEvent["kind"]): MonitorTimeClass {
  if (kind.startsWith("wait_")) return "external-wait";
  if (kind.startsWith("validation_")) return "validation";
  if (kind.startsWith("model_")) return "tool";
  return "agent";
}
