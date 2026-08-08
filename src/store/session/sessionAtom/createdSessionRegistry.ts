/**
 * Durable roster registry for sessions created on this client.
 *
 * Native creations stay here only until a backend roster page confirms them.
 * Locally owned rows (JSON snapshots and collaboration replay imports) have no
 * backend roster owner, so they remain until explicit deletion or bounded
 * oldest-first eviction. The registry stores only Session metadata, never
 * transcript content.
 */
import { z } from "zod/v4";

import {
  BASE_SESSION_LIST_CATEGORIES,
  type BaseSessionListCategory,
} from "./sessionRosterCategories";
import type { Session } from "./types";

const CLIENT_CREATED_SESSION_REGISTRY_STORAGE_KEY =
  "orgii:clientCreatedSessions:v1";
const LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY = "orgii:guestShareImports:v1";
const MAX_REGISTRY_ENTRIES = 200;

const StoredSessionSchema = z
  .object({
    session_id: z.string().min(1),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .catchall(z.unknown());

const RegistryEntrySchema = z.object({
  session: StoredSessionSchema,
  category: z.enum(BASE_SESSION_LIST_CATEGORIES),
  ownership: z.enum(["native", "local"]),
  recordedAt: z.number(),
});

const RegistrySchema = z.record(z.string(), RegistryEntrySchema);
const LegacyGuestRegistrySchema = z.record(z.string(), StoredSessionSchema);

type RegistryEntry = z.output<typeof RegistryEntrySchema>;
type Registry = z.output<typeof RegistrySchema>;

export type ClientCreatedSessionOwnership = "native" | "local";

export interface ClientCreatedRosterProjection {
  sessionId: string;
  category: BaseSessionListCategory;
  ownership: ClientCreatedSessionOwnership;
}

function toStoredSession(session: Session): RegistryEntry["session"] | null {
  const parsed = StoredSessionSchema.safeParse(session);
  return parsed.success ? parsed.data : null;
}

function toSession(session: RegistryEntry["session"]): Session {
  return session as unknown as Session;
}

function migrateLegacyGuestRegistry(): Registry {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY);
    if (!raw) return {};
    const legacy = LegacyGuestRegistrySchema.parse(JSON.parse(raw));
    const recordedAt = Date.now();
    return Object.fromEntries(
      Object.entries(legacy).map(([sessionId, session]) => [
        sessionId,
        {
          session,
          category: "standalone_agent" as const,
          ownership: "local" as const,
          recordedAt,
        },
      ])
    );
  } catch {
    return {};
  }
}

function readRegistry(): Registry {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(
      CLIENT_CREATED_SESSION_REGISTRY_STORAGE_KEY
    );
    if (raw) return RegistrySchema.parse(JSON.parse(raw));
  } catch {
    // Fall through to the legacy guest registry before resetting.
  }

  const migrated = migrateLegacyGuestRegistry();
  if (Object.keys(migrated).length > 0) {
    writeRegistry(migrated);
    localStorage.removeItem(LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY);
  }
  return migrated;
}

function writeRegistry(registry: Registry): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      CLIENT_CREATED_SESSION_REGISTRY_STORAGE_KEY,
      JSON.stringify(registry)
    );
  } catch {
    // Quota or privacy-mode failure leaves the in-memory roster operational.
  }
}

function pruneRegistry(registry: Registry): Registry {
  const entries = Object.entries(registry);
  if (entries.length <= MAX_REGISTRY_ENTRIES) return registry;

  const newestFirst = entries.sort(([leftId, left], [rightId, right]) => {
    const recorded = right.recordedAt - left.recordedAt;
    if (recorded !== 0) return recorded;
    const updated = right.session.updated_at.localeCompare(
      left.session.updated_at
    );
    if (updated !== 0) return updated;
    return rightId.localeCompare(leftId);
  });
  return Object.fromEntries(newestFirst.slice(0, MAX_REGISTRY_ENTRIES));
}

export function recordClientCreatedSession(
  session: Session,
  projection: {
    category: BaseSessionListCategory;
    ownership: ClientCreatedSessionOwnership;
  }
): void {
  const stored = toStoredSession(session);
  if (!stored) return;
  const registry = readRegistry();
  registry[session.session_id] = {
    session: stored,
    ...projection,
    recordedAt: Date.now(),
  };
  writeRegistry(pruneRegistry(registry));
}

/** Keep registry snapshots aligned with normal persisted Session metadata. */
export function syncClientCreatedSessionRecords(
  sessions: readonly Session[]
): void {
  const registry = readRegistry();
  let changed = false;
  for (const session of sessions) {
    const existing = registry[session.session_id];
    if (!existing) continue;
    const stored = toStoredSession(session);
    if (!stored) continue;
    registry[session.session_id] = { ...existing, session: stored };
    changed = true;
  }
  if (changed) writeRegistry(registry);
}

export function removeClientCreatedSession(sessionId: string): void {
  const registry = readRegistry();
  if (!(sessionId in registry)) return;
  delete registry[sessionId];
  writeRegistry(registry);
}

export function loadClientCreatedRosterProjections(): ClientCreatedRosterProjection[] {
  return Object.entries(readRegistry()).map(([sessionId, entry]) => ({
    sessionId,
    category: entry.category,
    ownership: entry.ownership,
  }));
}

export function getPendingNativeCreatedSessionIds(): ReadonlySet<string> {
  return new Set(
    Object.entries(readRegistry()).flatMap(([sessionId, entry]) =>
      entry.ownership === "native" ? [sessionId] : []
    )
  );
}

/**
 * Remove native-owned entries confirmed by an authoritative native read.
 * Local-owned rows deliberately ignore native acknowledgement.
 */
export function acknowledgeNativeCreatedSessions(
  sessions: readonly Session[]
): string[] {
  const registry = readRegistry();
  const confirmedIds = new Set(sessions.map((session) => session.session_id));
  const acknowledged: string[] = [];
  for (const [sessionId, entry] of Object.entries(registry)) {
    if (entry.ownership !== "native" || !confirmedIds.has(sessionId)) continue;
    acknowledged.push(sessionId);
    delete registry[sessionId];
  }
  if (acknowledged.length > 0) writeRegistry(registry);
  return acknowledged;
}

/**
 * Re-materialize registry-backed rows after a flat authoritative replacement.
 * Backend rows win on ID collision; confirmed native registrations are evicted.
 */
export function mergeClientCreatedSessions(
  sessions: readonly Session[],
  options: {
    include?: (session: Session) => boolean;
    acknowledgeNative?: boolean;
  } = {}
): Session[] {
  const registry = readRegistry();
  const presentIds = new Set(sessions.map((session) => session.session_id));
  let changed = false;
  if (options.acknowledgeNative !== false) {
    for (const [sessionId, entry] of Object.entries(registry)) {
      if (entry.ownership === "native" && presentIds.has(sessionId)) {
        delete registry[sessionId];
        changed = true;
      }
    }
  }
  if (changed) writeRegistry(registry);

  const merged = sessions.slice();
  for (const [sessionId, entry] of Object.entries(registry)) {
    const storedSession = toSession(entry.session);
    if (
      !presentIds.has(sessionId) &&
      (!options.include || options.include(storedSession))
    ) {
      merged.push(storedSession);
    }
  }
  return merged;
}

export const __CLIENT_CREATED_SESSION_REGISTRY_INTERNALS = {
  CLIENT_CREATED_SESSION_REGISTRY_STORAGE_KEY,
  LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY,
  MAX_REGISTRY_ENTRIES,
};
