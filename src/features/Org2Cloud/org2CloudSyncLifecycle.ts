import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";
import type { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const log = createLogger("Org2CloudSyncEngine");

export type CloudStore = ReturnType<typeof getInstrumentedStore>;

/** The app's ONLY recurring timer: every recurring cloud pull uses this chain. */
export const PASS_INTERVAL_MS = 60_000;
/** Hidden documents stretch the same timer chain instead of adding another. */
export const HIDDEN_PASS_INTERVAL_MS = 300_000;
const ACTIVITY_DEBOUNCE_MS = 3_000;
/** `orgii-data-changed` projects-plane debounce. */
export const DATA_CHANGED_DEBOUNCE_MS = 1_500;
/** One-shot retry just after the Rust outbox's first retry slot. */
export const PROJECT_PUSH_RETRY_DELAY_MS = 30_250;

/** Non-DOM contexts (workers and node-side tests) behave as visible. */
function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * Owns engine lifetime, timer cadence and serialized-pass coalescing.
 * Domain synchronization stays in the concrete engine so this class has no
 * knowledge of auth, orgs, sessions, projects, or task payloads.
 */
export abstract class Org2CloudSyncLifecycle {
  protected store: CloudStore | null = null;
  private started = false;
  /** Bumped on stop(); in-flight passes check it before writing. */
  protected generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private dataChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private projectPushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private dataChangedUnlisten: Promise<UnlistenFn> | null = null;
  private eventStoreUnsubscribe: (() => void) | null = null;
  private passRunning = false;
  private passDirty = false;
  /** Cancels pass-scoped, multi-request work such as external replay uploads. */
  private activePassAbortController: AbortController | null = null;
  /** Serialized passes actually started (test seam for pass-count budgets). */
  startedPassCount = 0;
  /** Explicit user-action waiters resolve after the active and dirty passes drain. */
  private readonly passDrainWaiters: Array<() => void> = [];

  /** Per-org last inbound pull time, preserving independent fallback cadence. */
  protected readonly lastInboundPassAtMs = new Map<string, number>();
  /** Realtime invalidations waiting to be consumed by a pass. */
  protected readonly pendingInboundOrgIds = new Set<string>();
  /** Reconnect/full-recovery requests that bypass cursors once. */
  protected readonly pendingFullInboundOrgIds = new Set<string>();
  protected forceAllInboundNextPass = false;
  /** Set by `orgii-data-changed` so the next pass drains the projects plane. */
  protected forceProjectsNextPass = false;

  protected abstract syncAllOrgs(
    generation: number,
    signal: AbortSignal
  ): Promise<void>;
  protected abstract noteSessionEventActivity(sessionId: string): void;
  protected abstract resetSyncState(): void;
  protected abstract clearOrgBackoff(orgId: string): void;
  protected abstract clearAllOrgBackoffs(): void;
  protected abstract invalidateFullInboundState(orgId?: string): void;

  /**
   * `visibilitychange` to visible collapses the existing chain into one
   * immediate pass. The bound property lets start/stop share the reference.
   */
  private readonly onVisibilityChange = (): void => {
    if (!this.started || isDocumentHidden()) return;
    this.schedulePass(0);
  };

  /**
   * A browser reconnect is a production sync trigger, not just a Realtime
   * transport concern. In particular, Project/Work Item writes can already
   * be durable in the Rust outbox while the first cloud listing fails. A
   * reconnect must therefore force both a fresh inbound recovery and an
   * outbox-draining projects pass immediately instead of waiting for the
   * minute fallback timer (or an E2E-only manual sync hook).
   */
  private readonly onOnline = (): void => {
    if (!this.started) return;
    this.clearAllOrgBackoffs();
    this.forceAllInboundNextPass = true;
    this.forceProjectsNextPass = true;
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
        this.scheduleActivityPass();
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
    this.schedulePass(0);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.activePassAbortController?.abort();
    this.activePassAbortController = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.activityTimer !== null) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    if (this.dataChangedTimer !== null) clearTimeout(this.dataChangedTimer);
    this.dataChangedTimer = null;
    if (this.projectPushRetryTimer !== null) {
      clearTimeout(this.projectPushRetryTimer);
    }
    this.projectPushRetryTimer = null;
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
    for (const resolve of this.passDrainWaiters.splice(0)) resolve();
    this.lastInboundPassAtMs.clear();
    this.pendingInboundOrgIds.clear();
    this.pendingFullInboundOrgIds.clear();
    this.forceAllInboundNextPass = false;
    this.forceProjectsNextPass = false;
    this.store = null;
  }

  /** Run a pass now (test seam / manual trigger). Serialized. */
  async runSyncPass(): Promise<void> {
    if (!this.started || !this.store) return;
    if (this.passRunning) {
      this.passDirty = true;
      return;
    }
    this.passRunning = true;
    this.startedPassCount += 1;
    const generation = this.generation;
    const abortController = new AbortController();
    this.activePassAbortController = abortController;
    try {
      await this.syncAllOrgs(generation, abortController.signal);
    } catch (error) {
      if (!abortController.signal.aborted) {
        log.warn("cloud sync pass failed:", error);
      }
    } finally {
      if (this.activePassAbortController === abortController) {
        this.activePassAbortController = null;
      }
      this.passRunning = false;
      if (this.started && this.generation === generation && this.passDirty) {
        this.passDirty = false;
        void this.runSyncPass();
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
  invalidateOrgInbound(orgId?: string, options: { full?: boolean } = {}): void {
    if (!this.started) return;
    if (orgId) {
      this.clearOrgBackoff(orgId);
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
    void this.runSyncPass();
  }

  /** Invalidate and resolve after all work coalesced into that pass drains. */
  async invalidateOrgInboundAndWait(
    orgId?: string,
    options: { full?: boolean } = {}
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
    this.invalidateOrgInbound(orgId, { full: true });
  }

  /** Resume an org and wait for the resulting serialized pass to drain. */
  async resumeOrgAndWait(orgId: string): Promise<void> {
    await this.invalidateOrgInboundAndWait(orgId, { full: true });
  }

  private schedulePass(delayMs: number): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSyncPass().finally(() => {
        this.schedulePass(
          isDocumentHidden() ? HIDDEN_PASS_INTERVAL_MS : PASS_INTERVAL_MS
        );
      });
    }, delayMs);
  }

  private scheduleActivityPass(): void {
    if (!this.started || isDocumentHidden()) return;
    if (this.activityTimer !== null) clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      if (isDocumentHidden()) return;
      void this.runSyncPass();
    }, ACTIVITY_DEBOUNCE_MS);
  }

  private scheduleProjectsPass(): void {
    if (!this.started) return;
    this.forceProjectsNextPass = true;
    if (isDocumentHidden()) return;
    if (this.dataChangedTimer !== null) clearTimeout(this.dataChangedTimer);
    this.dataChangedTimer = setTimeout(() => {
      this.dataChangedTimer = null;
      if (isDocumentHidden()) return;
      void this.runSyncPass();
    }, DATA_CHANGED_DEBOUNCE_MS);
  }

  /** Schedule one projects-plane pass at the durable outbox's retry point. */
  protected scheduleProjectPushRetry(): void {
    if (!this.started || this.projectPushRetryTimer !== null) return;
    this.projectPushRetryTimer = setTimeout(() => {
      this.projectPushRetryTimer = null;
      if (!this.started) return;
      this.forceProjectsNextPass = true;
      void this.runSyncPass();
    }, PROJECT_PUSH_RETRY_DELAY_MS);
  }
}
