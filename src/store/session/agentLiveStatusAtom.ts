/**
 * Live agent-status store fed by lifecycle hooks.
 *
 * The Rust backend normalizes every CLI's hook events into one four-state
 * vocabulary (`running` / `waiting_for_user` / `completed` / `failed`) and
 * pushes changes over the Tauri event `agent-live-status:changed`; initial
 * state hydrates from `agent_live_status_list`. Entries are keyed by BOTH the
 * canonical imported-history session id (`claudecodeapp-<uuid>`, ...) and,
 * for GUI-launched sessions, the ORGII session id — so any surface can look
 * up by whichever id it holds.
 *
 * `useAgentLiveStatusSync` is mounted once in AppBootstrap; on every push it
 * also patches the session store row via `updateSessionStatus`, which is what
 * the sidebar status dots render from.
 */
import { atom } from "jotai";

import { rpc } from "@src/api/tauri/rpc";
import type { AgentLiveStatus } from "@src/api/tauri/rpc/schemas/agentOrgs";
import { useTauriListen } from "@src/hooks/platform/useTauriListen";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { updateSessionStatus } from "./sessionAtom/mutations";
import type { SessionStatus } from "./sessionAtom/types";

export const AGENT_LIVE_STATUS_CHANGED_EVENT = "agent-live-status:changed";

export type AgentLiveStatusMap = Map<string, AgentLiveStatus>;

export const agentLiveStatusAtom = atom<AgentLiveStatusMap>(new Map());

const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "waiting_for_user",
  "completed",
  "failed",
]);

function toSessionStatus(status: string): SessionStatus | null {
  return LIVE_SESSION_STATUSES.has(status) ? (status as SessionStatus) : null;
}

function applyEntry(next: AgentLiveStatusMap, entry: AgentLiveStatus): void {
  next.set(entry.sessionId, entry);
  if (entry.orgiiSessionId) {
    next.set(entry.orgiiSessionId, entry);
  }
}

/**
 * True when two entries are equivalent for every field a consumer renders.
 * `updatedAtMs` is deliberately excluded: it bumps on every heartbeat but is
 * not read anywhere (the sidebar only renders `status` / `toolName` /
 * `interactivePrompt`). Treating a pure timestamp bump as "unchanged" lets
 * `ingestEntries` skip the Map clone and its downstream sidebar cascade.
 */
function entrySignificantlyEqual(
  a: AgentLiveStatus,
  b: AgentLiveStatus
): boolean {
  return (
    a.status === b.status &&
    a.source === b.source &&
    a.orgiiSessionId === b.orgiiSessionId &&
    a.toolName === b.toolName &&
    a.toolInputPreview === b.toolInputPreview &&
    a.interactivePrompt === b.interactivePrompt &&
    a.isInterrupt === b.isInterrupt
  );
}

function ingestEntries(entries: AgentLiveStatus[]): void {
  if (entries.length === 0) return;
  const store = getInstrumentedStore();
  store.set(agentLiveStatusAtom, (previous) => {
    // Clone lazily: pure heartbeat re-pushes (only `updatedAtMs` changed)
    // must not produce a new Map identity, or every mounted live-status
    // consumer re-renders on each tick.
    let next: AgentLiveStatusMap | null = null;
    for (const entry of entries) {
      const existing = previous.get(entry.sessionId);
      if (existing && entrySignificantlyEqual(existing, entry)) continue;
      if (!next) next = new Map(previous);
      applyEntry(next, entry);
    }
    return next ?? previous;
  });
  for (const entry of entries) {
    const status = toSessionStatus(entry.status);
    if (!status) continue;
    updateSessionStatus(entry.sessionId, status);
    if (entry.orgiiSessionId) {
      updateSessionStatus(entry.orgiiSessionId, status);
    }
  }
}

/**
 * Mount once (AppBootstrap): hydrates from the backend registry, then keeps
 * the atom and the session rows in sync with pushed status changes.
 */
export function useAgentLiveStatusSync(): void {
  useTauriListen<AgentLiveStatus>(AGENT_LIVE_STATUS_CHANGED_EVENT, (entry) => {
    ingestEntries([entry]);
  });

  useHydrateOnce();
}

let hydrateStarted = false;

function useHydrateOnce(): void {
  if (hydrateStarted) return;
  hydrateStarted = true;
  void rpc.agentOrgs.sessionProvenance
    .liveStatusList()
    .then((entries) => ingestEntries(entries))
    .catch(() => {
      // Hydration is a UI nicety; pushed events self-heal the store.
      hydrateStarted = false;
    });
}
