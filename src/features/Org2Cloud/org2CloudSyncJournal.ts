/**
 * ORG2 Cloud sync journal — the diagnostics feed behind the org panel's Sync
 * tab ("bug logs") plus the last-sync clock.
 *
 * Two very different kinds of state live here on purpose:
 *
 * - The ENTRIES are a bounded in-memory ring buffer (newest first, capped at
 *   `SYNC_JOURNAL_CAP`). They are diagnostics about what the engine just did,
 *   not application state, so they deliberately do NOT survive a restart and
 *   are never uploaded anywhere.
 * - The LAST-SYNC CLOCK (`lastPassAtMs` / `lastSuccessAtMs`) is real state a
 *   user asks about after a restart ("when did this machine last sync?"), so
 *   only those two numbers persist, through the same zod-validated
 *   localStorage idiom as `org2CloudAccessSettings` and under the same
 *   `orgii:org2-cloud-v1:*` key family.
 *
 * Everything recorded is stringified defensively (`describeSyncError`): a raw
 * `Error`, RPC response, or engine object must never be retained here, both to
 * keep the buffer bounded and to keep it trivially safe to render and copy.
 * Recording is pure bookkeeping — it never changes sync, retry, or backoff
 * behavior.
 *
 * The snapshot getters return REFERENTIALLY STABLE values between mutations so
 * `useSyncExternalStore` can consume them directly; rebuilding an array or
 * object per call would put React into an infinite re-render loop.
 */
import { useSyncExternalStore } from "react";
import { z } from "zod/v4";

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

export const SYNC_JOURNAL_LEVEL = {
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type SyncJournalLevel =
  (typeof SYNC_JOURNAL_LEVEL)[keyof typeof SYNC_JOURNAL_LEVEL];

/** Optional human identity attached to a sync event at its producer boundary. */
export interface SyncJournalMember {
  /** Stable identity used for filtering and copied diagnostics. */
  userId: string;
  /** Human-readable label. The UI falls back to `userId` when unavailable. */
  displayName?: string;
}

export interface SyncJournalEntry {
  /** Monotonic per-process id — deterministic, unlike `Math.random`. */
  id: string;
  atMs: number;
  level: SyncJournalLevel;
  /** Coarse producer tag, e.g. `sync_pass`, `org_backoff`, `member_runtime`. */
  kind: string;
  orgId?: string;
  member?: SyncJournalMember;
  message: string;
  /** Server error code when the source error carried one. */
  code?: string;
}

export interface SyncJournalLastSyncState {
  /** When a pass last FINISHED, successfully or not. */
  lastPassAtMs: number | null;
  /** When a pass last finished WITHOUT throwing. */
  lastSuccessAtMs: number | null;
}

/** Newest-first ring capacity. Passes are event-driven, so this is generous. */
export const SYNC_JOURNAL_CAP = 100;

/** Defensive bound on any single stringified message. */
const MESSAGE_MAX_LENGTH = 500;
const MEMBER_USER_ID_MAX_LENGTH = 256;
const MEMBER_DISPLAY_NAME_MAX_LENGTH = 120;

const LAST_SYNC_STORAGE_KEY = "orgii:org2-cloud-v1:syncLastPass";

const LastSyncStateSchema = z.object({
  lastPassAtMs: z.number().nullable(),
  lastSuccessAtMs: z.number().nullable(),
});

const lastSyncStorage = createZodJsonStorage(LastSyncStateSchema);

const EMPTY_ENTRIES: readonly SyncJournalEntry[] = Object.freeze([]);
const EMPTY_LAST_SYNC: SyncJournalLastSyncState = Object.freeze({
  lastPassAtMs: null,
  lastSuccessAtMs: null,
});

/**
 * Node-side tests and workers import this module without a DOM. Mirror the
 * `config.readEndpointOverride` guard rather than assuming `localStorage`.
 */
function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function readPersistedLastSync(): SyncJournalLastSyncState {
  if (!hasLocalStorage()) return EMPTY_LAST_SYNC;
  try {
    return lastSyncStorage.getItem(LAST_SYNC_STORAGE_KEY, EMPTY_LAST_SYNC);
  } catch {
    return EMPTY_LAST_SYNC;
  }
}

function writePersistedLastSync(value: SyncJournalLastSyncState): void {
  if (!hasLocalStorage()) return;
  try {
    lastSyncStorage.setItem(LAST_SYNC_STORAGE_KEY, value);
  } catch {
    // A full/blocked quota must never break a sync pass.
  }
}

// ============================================================================
// Store
// ============================================================================

let entries: readonly SyncJournalEntry[] = EMPTY_ENTRIES;
let lastSync: SyncJournalLastSyncState = readPersistedLastSync();
let idCounter = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function nextId(): string {
  idCounter += 1;
  return `sync-${idCounter}`;
}

function clampMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= MESSAGE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, MESSAGE_MAX_LENGTH - 1)}…`;
}

function clampIdentityField(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function normalizeMember(
  member: SyncJournalMember | undefined
): SyncJournalMember | undefined {
  if (!member) return undefined;
  const userId = clampIdentityField(
    String(member.userId ?? ""),
    MEMBER_USER_ID_MAX_LENGTH
  );
  if (!userId) return undefined;
  const displayName = member.displayName
    ? clampIdentityField(
        String(member.displayName),
        MEMBER_DISPLAY_NAME_MAX_LENGTH
      )
    : "";
  return displayName && displayName !== userId
    ? { userId, displayName }
    : { userId };
}

/**
 * Coerce anything a `catch` can hand us into a flat `{ message, code }`.
 *
 * `Org2CloudSyncError`, `Org2CloudProjectsError`, and `MemberRuntimeError` all
 * expose a `readonly code: <Code> | null`, so reading a string `code` off the
 * value covers every RPC error class without importing (and coupling to) any
 * of them. Nothing else about the value is retained.
 */
export function describeSyncError(error: unknown): {
  message: string;
  code?: string;
} {
  const code = readErrorCode(error);
  if (error instanceof Error) {
    const message = error.message || error.name || "Error";
    return code
      ? { message: clampMessage(message), code }
      : { message: clampMessage(message) };
  }
  if (typeof error === "string") {
    const message = clampMessage(error) || "Unknown error";
    return code ? { message, code } : { message };
  }
  if (error && typeof error === "object") {
    const raw = (error as { message?: unknown }).message;
    if (typeof raw === "string" && raw.trim()) {
      const message = clampMessage(raw);
      return code ? { message, code } : { message };
    }
  }
  let message: string;
  try {
    message = clampMessage(String(error)) || "Unknown error";
  } catch {
    message = "Unknown error";
  }
  return code ? { message, code } : { message };
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  const trimmed = code.trim();
  return trimmed ? trimmed.slice(0, 64) : undefined;
}

export type SyncJournalInput = Omit<SyncJournalEntry, "id" | "atMs"> & {
  atMs?: number;
};

/** Append one diagnostic entry, evicting the oldest past the cap. */
export function recordSyncEvent(input: SyncJournalInput): void {
  const member = normalizeMember(input.member);
  const entry: SyncJournalEntry = {
    id: nextId(),
    atMs: input.atMs ?? Date.now(),
    level: input.level,
    kind: input.kind,
    message: clampMessage(String(input.message ?? "")) || "Unknown error",
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(member ? { member } : {}),
    ...(input.code ? { code: input.code.slice(0, 64) } : {}),
  };
  // A fresh array per mutation is what keeps `getSyncJournalSnapshot`
  // referentially stable between mutations.
  const next = [entry, ...entries];
  if (next.length > SYNC_JOURNAL_CAP) next.length = SYNC_JOURNAL_CAP;
  entries = next;
  notify();
}

/** Newest first. Stable reference until the next mutation. */
export function getSyncJournalSnapshot(): readonly SyncJournalEntry[] {
  return entries;
}

/** Stable reference until the next `markSyncPass`. */
export function getLastSyncState(): SyncJournalLastSyncState {
  return lastSync;
}

export function subscribeSyncJournal(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** Drop the diagnostics buffer. The last-sync clock is untouched. */
export function clearSyncJournal(): void {
  if (entries.length === 0) return;
  entries = EMPTY_ENTRIES;
  notify();
}

/**
 * Record that a sync pass finished. `lastPassAtMs` always advances;
 * `lastSuccessAtMs` only on a pass that did not throw.
 */
export function markSyncPass(options: {
  success: boolean;
  atMs?: number;
}): void {
  const atMs = options.atMs ?? Date.now();
  lastSync = {
    lastPassAtMs: atMs,
    lastSuccessAtMs: options.success ? atMs : lastSync.lastSuccessAtMs,
  };
  writePersistedLastSync(lastSync);
  notify();
}

/** Test seam: wipe entries, the clock, and its persisted copy. */
export function resetSyncJournalForTests(): void {
  entries = EMPTY_ENTRIES;
  lastSync = EMPTY_LAST_SYNC;
  idCounter = 0;
  if (hasLocalStorage()) {
    try {
      lastSyncStorage.removeItem(LAST_SYNC_STORAGE_KEY);
    } catch {
      // Best effort.
    }
  }
  notify();
}

// ============================================================================
// React bindings
// ============================================================================

/** Newest-first journal entries, re-rendering as the engine records events. */
export function useSyncJournal(): readonly SyncJournalEntry[] {
  return useSyncExternalStore(
    subscribeSyncJournal,
    getSyncJournalSnapshot,
    getSyncJournalSnapshot
  );
}

/** The persisted last-pass / last-success clock. */
export function useLastSyncState(): SyncJournalLastSyncState {
  return useSyncExternalStore(
    subscribeSyncJournal,
    getLastSyncState,
    getLastSyncState
  );
}
