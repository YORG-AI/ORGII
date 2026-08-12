import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";
import type { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import {
  describeSyncError,
  markSyncPass,
  recordSyncEvent,
} from "./org2CloudSyncJournal";

const log = createLogger("Org2CloudSyncEngine");

export type CloudStore = ReturnType<typeof getInstrumentedStore>;

const ACTIVITY_DEBOUNCE_MS = 3_000;
/**
 * External CLI transcripts rewrite earlier mutable records while a turn is
 * streaming. Publishing each file change can therefore turn a single live
 * turn into a chain of full cloud rewrites. Wait for a quiet window and send
 * one converged replay instead. Native EventStore sessions keep the short
 * debounce because their append/tail protocol is already incremental.
 */
export const EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS = 30_000;
/** `orgii-data-changed` projects-plane debounce. */
export const DATA_CHANGED_DEBOUNCE_MS = 1_500;
/** One-shot retry just after the Rust outbox's first retry slot. */
export const PROJECT_PUSH_RETRY_DELAY_MS = 30_250;
/** Max-wait deadlines for the trailing debounces above: sub-window activity
 * must not starve the pass forever, only batch it. */
export const ACTIVITY_MAX_WAIT_MS = 15_000;
export const EXTERNAL_HISTORY_ACTIVITY_MAX_WAIT_MS = 60_000;
export const DATA_CHANGED_MAX_WAIT_MS = 15_000;

/** Non-DOM contexts (workers and node-side tests) behave as visible. */
function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * Owns engine lifetime, event-driven triggers and serialized-pass coalescing.
 * Domain synchronization stays in the concrete engine so this class has no
 * knowledge of auth, orgs, sessions, projects, or task payloads.
 */
export abstract class Org2CloudSyncLifecycle {
  protected store: CloudStore | null = null;
  private started = false;
  /** Bumped on stop(); in-flight passes check it before writing. */
  protected generation = 0;
  /** One-shot startup scheduling; never re-armed after it fires. */
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private activityFirstArmedAtMs = 0;
  private externalHistoryActivityTimer: ReturnType<typeof setTimeout> | null =
    null;
  private externalHistoryActivityFirstArmedAtMs = 0;
  private dataChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private dataChangedFirstArmedAtMs = 0;
  private projectPushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** At most one frontend retry for each concrete project-sync trigger. */
  private projectPushRetryBudget = 0;
  private dataChangedUnlisten: Promise<UnlistenFn> | null = null;
  private eventStoreUnsubscribe: (() => void) | null = null;
  private passRunning = false;
  private passDirty = false;
  /** A full/outbound trigger that arrived while the current pass was busy. */
  private nextPassPushSessions = false;
  /** Serialized passes actually started (test seam for pass-count budgets). */
  startedPassCount = 0;
  /** Explicit user-action waiters resolve after the active and dirty passes drain. */
  private readonly passDrainWaiters: Array<() => void> = [];

  /** Realtime invalidations waiting to be consumed by a pass. */
  protected readonly pendingInboundOrgIds = new Set<string>();
  /** Reconnect/full-recovery requests that bypass cursors once. */
  protected readonly pendingFullInboundOrgIds = new Set<string>();
  protected forceAllInboundNextPass = false;
  /** Set by `orgii-data-changed` so the next pass drains the projects plane. */
  protected forceProjectsNextPass = false;

  protected abstract syncAllOrgs(
    generation: number,
    options: { pushSessions: boolean }
  ): Promise<void>;
  protected abstract noteSessionEventActivity(sessionId: string): void;
  protected abstract resetSyncState(): void;
  protected abstract clearOrgBackoff(orgId: string): void;
  protected abstract clearAllOrgBackoffs(): void;
  protected abstract invalidateFullInboundState(orgId?: string): void;
  /** Release pass-scoped resources even when a pass exits early or fails. */
  protected afterSyncPass(): void {}

  /**
   * Visibility regain is a one-shot catch-up trigger. There is deliberately
   * no recurring cloud pass: hidden local mutations remain represented by
   * EventStore state / the durable Rust outbox and converge here.
   */
  private readonly onVisibilityChange = (): void => {
    if (!this.started || isDocumentHidden()) return;
    void this.runSyncPass();
  };

  /**
   * A browser reconnect is a production sync trigger, not just a Realtime
   * transport concern. In particular, Project/Work Item writes can already
   * be durable in the Rust outbox while the first cloud listing fails. A
   * reconnect must therefore force both a fresh inbound recovery and an
   * outbox-draining projects pass immediately instead of waiting for another
   * user or local-data event.
   */
  private readonly onOnline = (): void => {
    if (!this.started) return;
    this.clearAllOrgBackoffs();
    this.forceAllInboundNextPass = true;
    this.forceProjectsNextPass = true;
    this.armProjectPushRetry();
    this.invalidateFullInboundState();
    void this.runSyncPass();
  };

  /** Idempotent: subsequent calls while running are no-ops. */
  start(store: CloudStore): void {
    if (this.started) return;
    this.started = true;
    this.store = store;
    this.eventStoreUnsubscribe = eventStoreProxy.subscribe(
      (_snapshot, sessionId) => {
        this.noteSessionEventActivity(sessionId);
        this.scheduleActivityPass(sessionId);
      }
    );
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
    }
    this.dataChangedUnlisten = listen("orgii-data-changed", () => {
      this.scheduleProjectsPass();
    });
    // Initial login/start is one explicit full recovery + outbox drain. The
    // roster hook repeats this trigger after the async org listing arrives.
    this.forceAllInboundNextPass = true;
    this.forceProjectsNextPass = true;
    this.armProjectPushRetry();
    this.invalidateFullInboundState();
    this.bootstrapTimer = setTimeout(() => {
      this.bootstrapTimer = null;
      void this.runSyncPass();
    }, 0);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    if (this.bootstrapTimer !== null) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = null;
    if (this.activityTimer !== null) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    if (this.externalHistoryActivityTimer !== null) {
      clearTimeout(this.externalHistoryActivityTimer);
    }
    this.externalHistoryActivityTimer = null;
    if (this.dataChangedTimer !== null) clearTimeout(this.dataChangedTimer);
    this.dataChangedTimer = null;
    if (this.projectPushRetryTimer !== null) {
      clearTimeout(this.projectPushRetryTimer);
    }
    this.projectPushRetryTimer = null;
    this.projectPushRetryBudget = 0;
    void this.dataChangedUnlisten?.then((unlisten) => unlisten());
    this.dataChangedUnlisten = null;
    this.eventStoreUnsubscribe?.();
    this.eventStoreUnsubscribe = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
    }
    this.resetSyncState();
    this.passRunning = false;
    this.passDirty = false;
    this.nextPassPushSessions = false;
    for (const resolve of this.passDrainWaiters.splice(0)) resolve();
    this.pendingInboundOrgIds.clear();
    this.pendingFullInboundOrgIds.clear();
    this.forceAllInboundNextPass = false;
    this.forceProjectsNextPass = false;
    this.store = null;
  }

  /** Run a pass now (test seam / manual trigger). Serialized. */
  async runSyncPass(options: { pushSessions?: boolean } = {}): Promise<void> {
    if (!this.started || !this.store) return;
    const pushSessions = options.pushSessions !== false;
    if (this.passRunning) {
      this.passDirty = true;
      this.nextPassPushSessions ||= pushSessions;
      return;
    }
    this.passRunning = true;
    this.startedPassCount += 1;
    const generation = this.generation;
    try {
      await this.syncAllOrgs(generation, { pushSessions });
      // Journaling only — the pass outcome itself is unchanged.
      //
      // A successful pass advances the last-sync stamp but deliberately does
      // NOT consume a journal slot: passes are activity-debounced (~1.5-3s),
      // so success entries would evict every warning from the bounded ring
      // within minutes of active work — exactly when the log matters. The
      // journal is for problems; "it ran and worked" is the last-sync stamp.
      markSyncPass({ success: true });
    } catch (error) {
      log.warn("cloud sync pass failed:", error);
      markSyncPass({ success: false });
      const described = describeSyncError(error);
      recordSyncEvent({
        level: "error",
        kind: "sync_pass",
        message: described.message,
        code: described.code,
      });
    } finally {
      this.afterSyncPass();
      this.passRunning = false;
      if (this.started && this.generation === generation && this.passDirty) {
        this.passDirty = false;
        const nextPushSessions = this.nextPassPushSessions;
        this.nextPassPushSessions = false;
        void this.runSyncPass({ pushSessions: nextPushSessions });
      } else {
        for (const resolve of this.passDrainWaiters.splice(0)) resolve();
      }
    }
  }

  /** Request a pass and wait for it plus every coalesced dirty follow-up. */
  async runSyncPassAndWaitForDrain(): Promise<void> {
    if (!this.started || !this.store) return;
    const drained = new Promise<void>((resolve) => {
      this.passDrainWaiters.push(resolve);
    });
    void this.runSyncPass();
    await drained;
  }

  /** Realtime invalidation; ordinary changes target one org and keep cursors. */
  invalidateOrgInbound(
    orgId?: string,
    options: { full?: boolean; pushSessions?: boolean } = {}
  ): void {
    if (!this.started) return;
    if (orgId) {
      // Ordinary change signals must NOT reopen a quota/disabled cool-down —
      // any teammate activity would turn the 5/30-minute backoff into a
      // per-signal retry. Full recovery (resumeOrg, edge recovery, online)
      // is the deliberate escape hatch.
      if (options.full) this.clearOrgBackoff(orgId);
      this.pendingInboundOrgIds.add(orgId);
      if (options.full) {
        this.pendingFullInboundOrgIds.add(orgId);
        this.invalidateFullInboundState(orgId);
      }
    } else {
      this.clearAllOrgBackoffs();
      this.forceAllInboundNextPass = true;
      this.invalidateFullInboundState();
    }
    if (isDocumentHidden()) return;
    // Realtime invalidation is normally an inbound nudge. Running the outbound
    // session scan here fed our own server signal back into another replay
    // upload. Explicit policy/user actions opt back into outbound work.
    void this.runSyncPass({ pushSessions: options.pushSessions === true });
  }

  /** Invalidate and resolve after all work coalesced into that pass drains. */
  async invalidateOrgInboundAndWait(
    orgId?: string,
    options: { full?: boolean; pushSessions?: boolean } = {}
  ): Promise<void> {
    if (!this.started || !this.store) return;
    const drained = new Promise<void>((resolve) => {
      this.passDrainWaiters.push(resolve);
    });
    this.invalidateOrgInbound(orgId, options);
    await drained;
  }

  /** Resume immediately after a user-controlled access or policy change. */
  resumeOrg(orgId: string): void {
    this.invalidateOrgInbound(orgId, { full: true, pushSessions: true });
  }

  /** Resume an org and wait for the resulting serialized pass to drain. */
  async resumeOrgAndWait(orgId: string): Promise<void> {
    await this.invalidateOrgInboundAndWait(orgId, {
      full: true,
      pushSessions: true,
    });
  }

  /**
   * Authoritative roster changes are an event, not a polling reason. Reconcile
   * all newly accessible orgs once and drain any durable project outbox.
   */
  reconcileRoster(): void {
    if (!this.started) return;
    this.clearAllOrgBackoffs();
    this.forceAllInboundNextPass = true;
    this.forceProjectsNextPass = true;
    this.armProjectPushRetry();
    this.invalidateFullInboundState();
    if (isDocumentHidden()) return;
    void this.runSyncPass();
  }

  // Outbound event-driven paths deliberately run while hidden: a minimized
  // window with an agent streaming is still producing local writes, and
  // teammates must see the transcript advance. Only inbound-only nudges wait
  // for visibility.
  //
  // Trailing debounce with a max-wait: events arriving faster than the
  // window used to reset it forever, starving pushes for as long as the
  // activity lasted. The deadline caps that staleness without changing the
  // quiet-gap behavior.
  protected scheduleActivityPass(sessionId: string): void {
    if (!this.started) return;
    const externalHistory = isImportedHistorySession(sessionId);
    const timer = externalHistory
      ? this.externalHistoryActivityTimer
      : this.activityTimer;
    const now = Date.now();
    if (timer === null) {
      if (externalHistory) this.externalHistoryActivityFirstArmedAtMs = now;
      else this.activityFirstArmedAtMs = now;
    }
    if (timer !== null) clearTimeout(timer);
    const debounceMs = externalHistory
      ? EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS
      : ACTIVITY_DEBOUNCE_MS;
    const deadlineMs =
      (externalHistory
        ? this.externalHistoryActivityFirstArmedAtMs
        : this.activityFirstArmedAtMs) +
      (externalHistory
        ? EXTERNAL_HISTORY_ACTIVITY_MAX_WAIT_MS
        : ACTIVITY_MAX_WAIT_MS);
    const nextTimer = setTimeout(
      () => {
        if (externalHistory) this.externalHistoryActivityTimer = null;
        else this.activityTimer = null;
        void this.runSyncPass();
      },
      Math.max(1, Math.min(debounceMs, deadlineMs - now))
    );
    if (externalHistory) this.externalHistoryActivityTimer = nextTimer;
    else this.activityTimer = nextTimer;
  }

  private scheduleProjectsPass(): void {
    if (!this.started) return;
    this.forceProjectsNextPass = true;
    this.armProjectPushRetry();
    const now = Date.now();
    if (this.dataChangedTimer === null) this.dataChangedFirstArmedAtMs = now;
    if (this.dataChangedTimer !== null) clearTimeout(this.dataChangedTimer);
    this.dataChangedTimer = setTimeout(
      () => {
        this.dataChangedTimer = null;
        void this.runSyncPass({ pushSessions: false });
      },
      Math.max(
        1,
        Math.min(
          DATA_CHANGED_DEBOUNCE_MS,
          this.dataChangedFirstArmedAtMs + DATA_CHANGED_MAX_WAIT_MS - now
        )
      )
    );
  }

  /** Schedule one projects-plane pass at the durable outbox's retry point. */
  protected scheduleProjectPushRetry(): void {
    if (
      !this.started ||
      this.projectPushRetryTimer !== null ||
      this.projectPushRetryBudget <= 0
    ) {
      return;
    }
    this.projectPushRetryBudget -= 1;
    this.projectPushRetryTimer = setTimeout(() => {
      this.projectPushRetryTimer = null;
      if (!this.started) return;
      this.forceProjectsNextPass = true;
      void this.runSyncPass({ pushSessions: false });
    }, PROJECT_PUSH_RETRY_DELAY_MS);
  }

  /**
   * A new concrete trigger supersedes any older deferred retry and earns one
   * fresh retry. Persistent failures therefore stop after two attempts instead
   * of becoming a disguised 30-second polling loop.
   */
  private armProjectPushRetry(): void {
    if (this.projectPushRetryTimer !== null) {
      clearTimeout(this.projectPushRetryTimer);
      this.projectPushRetryTimer = null;
    }
    this.projectPushRetryBudget = 1;
  }
}
