/**
 * Headless comment-task runner. Drives ONE attempt of a comment task in place
 * on the owner's locally-owned writable session (no fork):
 *
 *   claim → start (claimed → running) → one address round (heartbeat loop:
 *   renew lease + bounded progress) → complete with a structured result +
 *   at most one report reply.
 *
 * React-free ON PURPOSE: every side effect — RPCs, agent drive, timers, UI
 * callbacks — goes through the injected `CommentTaskRunnerDeps` seam, so the
 * protocol is provable fetch-free in unit tests.
 * `buildDefaultCommentTaskRunnerDeps` wires the real implementations; the UI
 * supplies only the report-insert / progress hooks.
 *
 * Coordination discipline:
 * - The `leaseToken` fencing credential lives ONLY inside the run's call
 *   scope: never stored, never logged, never part of a progress event or
 *   outcome — nothing reachable by render code sees it.
 * - `ORG2_CONFLICT` is disambiguated BY CALL SITE: on claim it means
 *   "already being handled / attempt cap" (abort, nothing held); on
 *   start/heartbeat/complete it means "lease lost" — stop ALL coordination
 *   writes silently while the local session continues normally.
 */
import { getSessionMetadata } from "@src/engines/SessionCore/storage/sqliteCache";
import { createLogger } from "@src/hooks/logger";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import type {
  AddressRoundInput,
  AddressRoundResult,
} from "./addressCommentsRun";
import {
  getLastRoundReply,
  isAddressRunActive,
  registerAddressRunFinishedListener,
  runAddressCommentsRound,
} from "./addressCommentsRun";
import {
  agentTaskRunnerSettingsAtom,
  resolveAgentRunnerSettings,
} from "./agentTaskRunnerSettingsAtom";
import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import { org2CloudCommentTasksAtom } from "./org2CloudCommentTasksAtom";
import {
  CLOUD_TASK_HEARTBEAT_MS,
  claimCommentTask,
  completeCommentTask,
  heartbeatCommentTask,
  isOrg2TaskErrorCode,
  releaseCommentTask,
  startCommentTask,
} from "./org2CloudCommentTasksClient";
import type { CloudCommentTask } from "./org2CloudCommentTasksClient";
import { broadcastCommentsChanged } from "./org2CloudCommentsBus";
import type { CloudSessionComment } from "./org2CloudCommentsClient";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";

const log = createLogger("commentTaskRunner");

/**
 * Report/summary bound. The server allows `p_report_body` 1..4000 and
 * `result` ≤ 8000 SERIALIZED chars; the same summary string appears in both,
 * and JSON escaping can double a newline-heavy transcript excerpt — 3000
 * keeps the serialized result comfortably under the cap in the worst case.
 */
const REPORT_SUMMARY_MAX_CHARS = 3000;

// ---------------------------------------------------------------------------
// Deps seam
// ---------------------------------------------------------------------------

/** UI-facing progress. Never carries coordination credentials. */
export interface CommentTaskRunProgress {
  phase: "claiming" | "starting" | "running" | "reporting";
  /** Present once the run is bound to a local session. */
  forkSessionId?: string;
  /** Present on running ticks when the local event store is readable. */
  eventCount?: number;
}

/**
 * Every side effect of a run, injectable for fetch-free tests. The RPC
 * members reuse the client wrappers' exact signatures (first param is a
 * fresh JWT from `withFreshToken` — the wrappers never refresh).
 */
export interface CommentTaskRunnerDeps {
  /**
   * The `ensureFreshSession` + `commitRefreshedAuth` composition: returns a
   * fresh access token for ONE coordination write batch, throwing when no
   * usable cloud session exists. Called before every write — runs outlive
   * a single JWT.
   */
  withFreshToken: () => Promise<string>;
  claimCommentTask: typeof claimCommentTask;
  startCommentTask: typeof startCommentTask;
  heartbeatCommentTask: typeof heartbeatCommentTask;
  completeCommentTask: typeof completeCommentTask;
  releaseCommentTask: typeof releaseCommentTask;
  /** Local event count for progress/result; undefined = unavailable. */
  countSessionEvents: (sessionId: string) => Promise<number | undefined>;
  resolveLocalWritableSessionId?: (sessionId: string) => string | null;
  runAddressRound?: (input: AddressRoundInput) => Promise<AddressRoundResult>;
  /** Insert the returned `agent_report` reply (Phase-4 atom wiring). */
  onReportComment: (comment: CloudSessionComment) => void;
  /** Optional UI progress listener; a throw here never affects the run. */
  onStateChange?: (progress: CommentTaskRunProgress) => void;
  /** Injectable timers (fake-timer tests + the CPU no-leak guarantee). */
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
}

// ---------------------------------------------------------------------------
// Run outcome
// ---------------------------------------------------------------------------

/** Structured `result` written by complete (mirrored into `task.result`). */
export interface CommentTaskAttemptResult {
  ok: boolean;
  summary: string;
  forkSessionId?: string;
  eventCount?: number;
  durationMs: number;
  /** Failure class on `ok:false`; the server mirrors it into `errorCode`. */
  errorKind?: string;
}

/**
 * Every end state a run can reach, one card rendering each (design §4 UI).
 * `leaseToken` is structurally absent — outcomes are safe to hand to render
 * code.
 */
export type CommentTaskRunOutcome =
  /** Claim ORG2_CONFLICT: live holder or attempt cap. Nothing was held. */
  | { kind: "already_claimed" }
  /**
   * ORG2_RETENTION_EXPIRED (claim): retention-locked — Phase 4 renders the
   * billing upgrade deep-link.
   */
  | { kind: "retention" }
  /**
   * The run was cancelled (another round already drives the session). Claim
   * released — no report posted.
   */
  | { kind: "cancelled"; forkSessionId?: string }
  /**
   * Fenced out (start/heartbeat/complete ORG2_CONFLICT): another runner
   * holds the task now. Coordination writes stopped silently; the local
   * session stays normal.
   */
  | { kind: "lease_lost"; forkSessionId?: string }
  /** Protocol-complete: the round ran and the result was reported. */
  | {
      kind: "completed";
      /** The agent turn's verdict (false = terminal non-completed status). */
      ok: boolean;
      forkSessionId: string;
      summary: string;
      /** Present when the server inserted the agent report reply. */
      reportComment?: CloudSessionComment;
      /** 'quota' etc. — report skipped but the task still completed. */
      reportSkipped?: string;
    }
  /** This attempt broke. */
  | {
      kind: "failed";
      errorKind: string;
      message: string;
      forkSessionId?: string;
      /** true = complete(ok:false) + report reached the thread. */
      reported: boolean;
    };

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetentionExpiredError(error: unknown): boolean {
  return (
    isOrg2TaskErrorCode(error, "ORG2_RETENTION_EXPIRED") ||
    isOrg2SyncErrorCode(error, "ORG2_RETENTION_EXPIRED")
  );
}

/** Same explicit truncation mark as the briefing/handoff bounds. */
function boundSummary(text: string): string {
  return text.length > REPORT_SUMMARY_MAX_CHARS
    ? `${text.slice(0, REPORT_SUMMARY_MAX_CHARS)}…`
    : text;
}

// ---------------------------------------------------------------------------
// Coordination-write helpers (all failures classified, never thrown upward)
// ---------------------------------------------------------------------------

/**
 * Best-effort voluntary release. A failure is logged and swallowed: the
 * lease lazily expires server-side, so the task always returns to
 * claimable — release is an optimization, never a correctness hinge.
 */
async function safeRelease(
  deps: CommentTaskRunnerDeps,
  orgId: string,
  taskId: string,
  leaseToken: string
): Promise<void> {
  try {
    const token = await deps.withFreshToken();
    await deps.releaseCommentTask(token, orgId, taskId, leaseToken);
  } catch (error) {
    log.warn(
      `comment task ${taskId}: release failed (lease will lazily expire): ${errorMessage(error)}`
    );
  }
}

type CompletionAttempt =
  | {
      status: "reported";
      reportComment?: CloudSessionComment;
      reportSkipped?: string;
    }
  | { status: "lease_lost" }
  | { status: "failed"; message: string };

/** Terminal write, with ORG2_CONFLICT read as lease-lost (call-site rule). */
async function tryComplete(
  deps: CommentTaskRunnerDeps,
  params: {
    orgId: string;
    taskId: string;
    leaseToken: string;
    ok: boolean;
    result: CommentTaskAttemptResult;
    reportBody?: string;
  }
): Promise<CompletionAttempt> {
  try {
    const token = await deps.withFreshToken();
    const completion = await deps.completeCommentTask(token, {
      orgId: params.orgId,
      taskId: params.taskId,
      leaseToken: params.leaseToken,
      ok: params.ok,
      result: params.result,
      reportBody: params.reportBody,
    });
    return {
      status: "reported",
      reportComment: completion.reportComment,
      reportSkipped: completion.reportSkipped,
    };
  } catch (error) {
    if (isOrg2TaskErrorCode(error, "ORG2_CONFLICT")) {
      return { status: "lease_lost" };
    }
    return { status: "failed", message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// In-place run (owned writable session — no fork)
// ---------------------------------------------------------------------------

export interface RunInPlaceCommentTaskInput {
  orgId: string;
  task: CloudCommentTask;
  localSessionId: string;
  /**
   * The task's thread was already answered by the just-finished batch
   * round (the reply is live in the thread). Complete without running a
   * new round, reusing that reply as the report body.
   */
  priorRoundReply?: string;
}

export async function runInPlaceCommentTask(
  input: RunInPlaceCommentTaskInput,
  deps: CommentTaskRunnerDeps
): Promise<CommentTaskRunOutcome> {
  const { orgId, task, localSessionId } = input;
  const runRound = deps.runAddressRound;
  if (!runRound) {
    throw new Error("in-place comment task run requires runAddressRound");
  }
  const emit = (progress: CommentTaskRunProgress): void => {
    try {
      deps.onStateChange?.(progress);
    } catch (listenerError) {
      log.warn(
        `comment task ${task.id}: progress listener threw: ${errorMessage(listenerError)}`
      );
    }
  };

  emit({ phase: "claiming" });
  let leaseToken: string;
  try {
    const claimToken = await deps.withFreshToken();
    const claim = await deps.claimCommentTask(claimToken, orgId, task.id);
    leaseToken = claim.leaseToken;
    broadcastCommentsChanged(orgId, task.sessionId);
  } catch (error) {
    if (isOrg2TaskErrorCode(error, "ORG2_CONFLICT")) {
      return { kind: "already_claimed" };
    }
    if (isRetentionExpiredError(error)) {
      return { kind: "retention" };
    }
    throw error;
  }

  const startedAtMs = deps.now();

  const completeAsFailure = async (failure: {
    errorKind: string;
    error: unknown;
    humanIntro: string;
  }): Promise<CommentTaskRunOutcome> => {
    const message = errorMessage(failure.error);
    const reportBody = boundSummary(`${failure.humanIntro}: ${message}`);
    const completion = await tryComplete(deps, {
      orgId,
      taskId: task.id,
      leaseToken,
      ok: false,
      result: {
        ok: false,
        summary: reportBody,
        forkSessionId: localSessionId,
        durationMs: deps.now() - startedAtMs,
        errorKind: failure.errorKind,
      },
      reportBody,
    });
    if (completion.status === "lease_lost") {
      return { kind: "lease_lost", forkSessionId: localSessionId };
    }
    return {
      kind: "failed",
      errorKind: failure.errorKind,
      message,
      forkSessionId: localSessionId,
      reported: completion.status === "reported",
    };
  };

  emit({ phase: "starting", forkSessionId: localSessionId });
  try {
    const startToken = await deps.withFreshToken();
    await deps.startCommentTask(
      startToken,
      orgId,
      task.id,
      leaseToken,
      localSessionId
    );
    broadcastCommentsChanged(orgId, task.sessionId);
  } catch (error) {
    if (isOrg2TaskErrorCode(error, "ORG2_CONFLICT")) {
      return { kind: "lease_lost", forkSessionId: localSessionId };
    }
    return completeAsFailure({
      errorKind: "dispatch_failed",
      error,
      humanIntro: "In-place agent round failed before the agent turn started",
    });
  }

  let round: AddressRoundResult;
  let leaseLost = false;
  if (input.priorRoundReply !== undefined) {
    round = {
      status: "ran",
      threadCount: 1,
      replyCount: 1,
      summary: "",
      heldReply: input.priorRoundReply,
    };
  } else {
    emit({ phase: "running", forkSessionId: localSessionId });
    const heartbeatHandle = deps.setInterval(() => {
      void (async () => {
        if (leaseLost) return;
        const eventCount = await deps
          .countSessionEvents(localSessionId)
          .catch(() => undefined);
        try {
          const heartbeatToken = await deps.withFreshToken();
          await deps.heartbeatCommentTask(heartbeatToken, {
            orgId,
            taskId: task.id,
            leaseToken,
            progress: {
              phase: "running",
              ...(eventCount !== undefined ? { eventCount } : {}),
            },
          });
          emit({ phase: "running", forkSessionId: localSessionId, eventCount });
        } catch (error) {
          if (isOrg2TaskErrorCode(error, "ORG2_CONFLICT")) {
            leaseLost = true;
            return;
          }
          log.warn(
            `comment task ${task.id}: in-place heartbeat failed: ${errorMessage(error)}`
          );
        }
      })();
    }, CLOUD_TASK_HEARTBEAT_MS);

    try {
      round = await runRound({
        orgId,
        cloudSessionId: task.sessionId,
        localSessionId,
        // Dedupe: the task thread's parsed reply is HELD by the round and
        // delivered once, as the completion report reply below.
        holdReplyForCommentId: task.commentId,
      });
    } catch (error) {
      deps.clearInterval(heartbeatHandle);
      if (leaseLost) {
        return { kind: "lease_lost", forkSessionId: localSessionId };
      }
      return completeAsFailure({
        errorKind: "run_failed",
        error,
        humanIntro: "In-place agent round failed while executing",
      });
    }
    deps.clearInterval(heartbeatHandle);
  }
  if (leaseLost) {
    return { kind: "lease_lost", forkSessionId: localSessionId };
  }
  if (round.status === "skipped_active") {
    await safeRelease(deps, orgId, task.id, leaseToken);
    return { kind: "cancelled", forkSessionId: localSessionId };
  }

  emit({ phase: "reporting", forkSessionId: localSessionId });
  const eventCount = await deps
    .countSessionEvents(localSessionId)
    .catch(() => undefined);
  const summary = boundSummary(
    round.status === "ran"
      ? (round.heldReply ??
          (round.replyCount > 0
            ? `Addressed ${round.threadCount} comment thread(s) in place; posted ${round.replyCount} repl${round.replyCount === 1 ? "y" : "ies"} below.`
            : round.summary.trim().length > 0
              ? round.summary.trim()
              : `Addressed ${round.threadCount} comment thread(s) in place on the owning session; no closing summary was found in the transcript.`))
      : "No unresolved comment threads remained when the agent run started."
  );
  const completion = await tryComplete(deps, {
    orgId,
    taskId: task.id,
    leaseToken,
    ok: true,
    result: {
      ok: true,
      summary,
      forkSessionId: localSessionId,
      ...(eventCount !== undefined ? { eventCount } : {}),
      durationMs: deps.now() - startedAtMs,
    },
    ...(input.priorRoundReply !== undefined ? {} : { reportBody: summary }),
  });
  if (completion.status === "lease_lost") {
    return { kind: "lease_lost", forkSessionId: localSessionId };
  }
  if (completion.status === "failed") {
    return {
      kind: "failed",
      errorKind: "report_failed",
      message: completion.message,
      forkSessionId: localSessionId,
      reported: false,
    };
  }
  if (completion.reportComment !== undefined) {
    try {
      deps.onReportComment(completion.reportComment);
    } catch (insertError) {
      log.warn(
        `comment task ${task.id}: local report insert failed: ${errorMessage(insertError)}`
      );
    }
  }
  broadcastCommentsChanged(orgId, task.sessionId);
  return {
    kind: "completed",
    ok: true,
    forkSessionId: localSessionId,
    summary,
    ...(completion.reportComment !== undefined
      ? { reportComment: completion.reportComment }
      : {}),
    ...(completion.reportSkipped !== undefined
      ? { reportSkipped: completion.reportSkipped }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Owner-side auto-claim (@agent → task → in-place round on this machine)
// ---------------------------------------------------------------------------

const autoRunTaskIds = new Set<string>();

let addressRunRekickRegistered = false;

function ensureAddressRunRekick(): void {
  if (addressRunRekickRegistered) return;
  addressRunRekickRegistered = true;
  registerAddressRunFinishedListener(() => {
    kickCommentTaskRunner();
  });
}

export function kickCommentTaskRunner(): void {
  ensureAddressRunRekick();
  let store: ReturnType<typeof getInstrumentedStore>;
  try {
    store = getInstrumentedStore();
  } catch {
    return;
  }
  if (!store.get(org2CloudAuthAtom)) return;
  const tasksByOrg = store.get(org2CloudCommentTasksAtom);
  const settingsByOrg = store.get(agentTaskRunnerSettingsAtom);
  for (const [orgId, taskMap] of Object.entries(tasksByOrg)) {
    // Owner opt-in gate (default OFF): without it a teammate's @agent mention
    // would silently claim and spend the owner's tokens. Skipped orgs leave
    // the task open server-side for the owner's explicit "Run here" consent.
    if (!resolveAgentRunnerSettings(settingsByOrg, orgId).autoRunEnabled) {
      continue;
    }
    for (const task of Object.values(taskMap)) {
      if (task.state !== "open") continue;
      if (autoRunTaskIds.has(task.id)) continue;
      const deps = buildDefaultCommentTaskRunnerDeps({
        onReportComment: () => {},
      });
      const localSessionId =
        deps.resolveLocalWritableSessionId?.(task.sessionId) ?? null;
      if (localSessionId === null) continue;
      if (isAddressRunActive(localSessionId)) continue;
      autoRunTaskIds.add(task.id);
      const priorRoundReply = getLastRoundReply(localSessionId, task.commentId);
      void runInPlaceCommentTask(
        {
          orgId,
          task,
          localSessionId,
          ...(priorRoundReply !== undefined ? { priorRoundReply } : {}),
        },
        deps
      )
        .then((outcome) => {
          log.info(`auto in-place comment task ${task.id}: ${outcome.kind}`);
        })
        .catch((error) => {
          log.warn(
            `auto in-place comment task ${task.id} failed: ${errorMessage(error)}`
          );
        })
        .finally(() => {
          autoRunTaskIds.delete(task.id);
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Default (real) deps
// ---------------------------------------------------------------------------

/** The human-decision hooks only the Phase-4 UI can supply. */
export interface CommentTaskRunnerUiHooks {
  onReportComment: CommentTaskRunnerDeps["onReportComment"];
  onStateChange?: CommentTaskRunnerDeps["onStateChange"];
}

export { readRunSummaryFromEventStore } from "./addressCommentsRun";

/**
 * Wire the real side effects behind the deps seam. React-free — callable
 * from any dev harness; the UI adds only its insert/progress hooks.
 */
export function buildDefaultCommentTaskRunnerDeps(
  ui: CommentTaskRunnerUiHooks
): CommentTaskRunnerDeps {
  return {
    withFreshToken: async () => {
      const store = getInstrumentedStore();
      const current = store.get(org2CloudAuthAtom);
      if (!current) {
        throw new Error("org2 cloud sign-in required to run a comment task");
      }
      const fresh = await ensureFreshSession(current);
      if (!fresh) {
        throw new Error("org2 cloud session refresh failed");
      }
      // Compare-and-set — never resurrect a signed-out auth atom.
      commitRefreshedAuth(
        (updater) => store.set(org2CloudAuthAtom, updater),
        current,
        fresh
      );
      return fresh.accessToken;
    },
    claimCommentTask,
    startCommentTask,
    heartbeatCommentTask,
    completeCommentTask,
    releaseCommentTask,
    // Cheap SQLite metadata-row read: the heartbeat's eventCount is cosmetic
    // progress, so it must never pull the FULL growing transcript across the
    // IPC bridge once a minute. Lags ingestion by at most one write batch.
    countSessionEvents: async (sessionId) =>
      (await getSessionMetadata(sessionId))?.eventCount,
    resolveLocalWritableSessionId: (sessionId) => {
      const store = getInstrumentedStore();
      const local = store
        .get(sessionsAtom)
        .find((session) => session.session_id === sessionId);
      return local && !local.importedFrom ? sessionId : null;
    },
    runAddressRound: runAddressCommentsRound,
    onReportComment: ui.onReportComment,
    onStateChange: ui.onStateChange,
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
    clearInterval: (handle) =>
      globalThis.clearInterval(
        handle as ReturnType<typeof globalThis.setInterval>
      ),
    now: () => Date.now(),
  };
}
