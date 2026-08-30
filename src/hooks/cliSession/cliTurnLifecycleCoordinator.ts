import { rpc } from "@src/api/tauri/rpc";
import { getTurnIntentDispatch } from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  beginTurnDispatch,
  clearTurnLifecycleSession,
  getTurnGeneration,
  getTurnPhase,
  markTurnTerminal,
} from "@src/engines/SessionCore/control/turnLifecycle";
import {
  cliTerminalStatus,
  isCliTerminalStatus,
  markCliRuntimeRunning,
  markObservedCliTerminalStatus,
} from "@src/engines/SessionCore/sync/adapters/cli/cliLifecycle";
import {
  toCliSessionStatus,
  toSessionListStatus,
} from "@src/engines/SessionCore/sync/sessionSyncUtils";
import { sessionsAtom, updateSessionStatus } from "@src/store/session";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";
import { isCliSession } from "@src/util/session/sessionDispatch";

export interface CliRunReceipt {
  sessionId: string;
  turnIntentId: string;
  status: string;
}

export interface CliLifecycleStatus {
  sessionId: string;
  status: string;
  updatedAt?: string;
  turnIntentId?: string;
}

interface ActiveCliTurn {
  turnIntentId: string;
  generation: number;
}

const MAX_ACTIVE_SESSIONS = 256;
const MAX_RECENT_TERMINALS = 256;
const RECONCILE_STATUSES = new Set([
  "pending",
  "running",
  "waiting_for_user",
  "waiting_for_funds",
]);

type BatchLoader = (input: {
  sessionIds: string[];
}) => Promise<CliLifecycleStatus[]>;

export class CliTurnLifecycleCoordinator {
  private readonly activeBySession = new Map<string, ActiveCliTurn>();
  private readonly recentTerminalIntents = new Set<string>();
  private reconcilePromise: Promise<CliLifecycleStatus[]> | null = null;

  constructor(private readonly loadStatusBatch: BatchLoader) {}

  get activeSessionCount(): number {
    return this.activeBySession.size;
  }

  registerReceipt(receipt: CliRunReceipt): void {
    this.handleStatus({
      sessionId: receipt.sessionId,
      turnIntentId: receipt.turnIntentId,
      status: receipt.status,
    });
  }

  handleStatus(event: CliLifecycleStatus): boolean {
    if (!isCliSession(event.sessionId)) return false;
    // `CliLifecycleStatus.status` is the raw wire string — it arrives from the
    // `cli.statusBatch` RPC and from run receipts. Narrow it here, at the entry
    // point, so every downstream branch (the terminal guard, the turn-lifecycle
    // writes, the session-list row) works on a validated value instead of an
    // `as` cast. An unrecognised value narrows to `"idle"`, which is neither
    // `"running"` nor terminal, so it is ignored exactly as before.
    const status = toCliSessionStatus(event.status);
    const turnIntentId = event.turnIntentId;
    const existing = this.activeBySession.get(event.sessionId);

    if (status === "running") {
      if (!turnIntentId || this.recentTerminalIntents.has(turnIntentId))
        return false;
      if (existing?.turnIntentId === turnIntentId) {
        markCliRuntimeRunning(event.sessionId, existing.generation);
        return false;
      }

      const dispatch = getTurnIntentDispatch(turnIntentId);
      if (dispatch && dispatch.sessionId !== event.sessionId) return false;
      if (dispatch && existing && dispatch.generation < existing.generation) {
        return false;
      }
      // Unknown cross-window intents need a retained generation so their
      // terminal cannot close a newer turn. Never evict another active
      // session merely to admit one beyond the bounded coordinator capacity.
      if (
        !dispatch &&
        !existing &&
        this.activeBySession.size >= MAX_ACTIVE_SESSIONS
      ) {
        return false;
      }

      const generation =
        dispatch?.generation ?? beginTurnDispatch(event.sessionId);
      markCliRuntimeRunning(event.sessionId, generation);
      if (getTurnGeneration(event.sessionId) !== generation) return false;
      this.setActive(event.sessionId, { turnIntentId, generation });
      return true;
    }

    if (!isCliTerminalStatus(status)) return false;
    if (!turnIntentId && existing) return false;
    if (turnIntentId && this.recentTerminalIntents.has(turnIntentId))
      return false;
    if (turnIntentId && existing && existing.turnIntentId !== turnIntentId) {
      return false;
    }

    const dispatch = turnIntentId
      ? getTurnIntentDispatch(turnIntentId)
      : undefined;
    if (dispatch && dispatch.sessionId !== event.sessionId) return false;
    const generation = existing?.generation ?? dispatch?.generation;
    markTurnTerminal(event.sessionId, cliTerminalStatus(status), {
      generation,
    });
    markObservedCliTerminalStatus(event.sessionId, status);
    if (isStoreInitialized()) {
      updateSessionStatus(event.sessionId, toSessionListStatus(status));
    }
    this.activeBySession.delete(event.sessionId);
    if (turnIntentId) this.rememberTerminal(turnIntentId);
    return true;
  }

  reconcile(): Promise<CliLifecycleStatus[]> {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return Promise.resolve([]);
    }
    if (this.reconcilePromise) return this.reconcilePromise;

    const sessionIds = this.collectReconcileSessionIds();
    if (sessionIds.length === 0) return Promise.resolve([]);
    this.reconcilePromise = this.loadStatusBatch({ sessionIds })
      .then((statuses) => {
        return statuses.filter((status) => this.handleStatus(status));
      })
      .finally(() => {
        this.reconcilePromise = null;
      });
    return this.reconcilePromise;
  }

  clearSession(sessionId: string): void {
    this.activeBySession.delete(sessionId);
    clearTurnLifecycleSession(sessionId);
  }

  resetForTests(): void {
    this.activeBySession.clear();
    this.recentTerminalIntents.clear();
    this.reconcilePromise = null;
  }

  private collectReconcileSessionIds(): string[] {
    const ids = new Set(this.activeBySession.keys());
    if (isStoreInitialized()) {
      for (const session of getInstrumentedStore().get(sessionsAtom)) {
        if (
          isCliSession(session.session_id) &&
          (RECONCILE_STATUSES.has(session.status) ||
            getTurnPhase(session.session_id) !== "idle")
        ) {
          ids.add(session.session_id);
        }
      }
    }
    return [...ids].slice(0, MAX_ACTIVE_SESSIONS);
  }

  private setActive(sessionId: string, active: ActiveCliTurn): void {
    this.activeBySession.delete(sessionId);
    this.activeBySession.set(sessionId, active);
  }

  private rememberTerminal(turnIntentId: string): void {
    this.recentTerminalIntents.delete(turnIntentId);
    this.recentTerminalIntents.add(turnIntentId);
    while (this.recentTerminalIntents.size > MAX_RECENT_TERMINALS) {
      const oldest = this.recentTerminalIntents.values().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.recentTerminalIntents.delete(oldest);
    }
  }
}

export const cliTurnLifecycleCoordinator = new CliTurnLifecycleCoordinator(
  rpc.cli.statusBatch
);

export function clearCliTurnLifecycleSession(sessionId: string): void {
  cliTurnLifecycleCoordinator.clearSession(sessionId);
}
