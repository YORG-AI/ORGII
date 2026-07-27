/**
 * Durable registry for guest share-token imports (design §6.4).
 *
 * A guest cloud import is neither a native backend row nor an external-adapter
 * source row, so every authoritative `loadSessions()` replace would erase it —
 * and with it the ONLY copy of the share capability (`shareToken` + issuing
 * `shareEndpointUrl`) a later fork or parent navigation needs. Member imports
 * are excluded on purpose: the engine pull loop re-materializes them from org
 * membership on every pass; guests have no such loop.
 *
 * Same durability posture as the fork relay registry (`forkSession.ts`):
 * zod-validated localStorage, corrupt payloads silently reset, bounded size.
 */
import { z } from "zod/v4";

import type { Session } from "./types";

const GUEST_IMPORT_REGISTRY_STORAGE_KEY = "orgii:guestShareImports:v1";

const MAX_REGISTRY_ENTRIES = 100;

const SessionSourceDisplayMetadataSchema = z.object({
  cliAgentType: z.string().optional(),
  agentDisplayName: z.string().optional(),
  agentDefinitionId: z.string().optional(),
  model: z.string().optional(),
});

const GuestImportedFromSchema = z.object({
  orgId: z.string(),
  sourceSessionId: z.string(),
  sourceEndpointUrl: z.string().optional(),
  ownerMemberId: z.string(),
  epoch: z.number(),
  seq: z.number(),
  count: z.number(),
  frozenCount: z.number().optional(),
  tailHash: z.string().optional(),
  ownerDisplayName: z.string().optional(),
  ownerAvatarUrl: z.string().optional(),
  externalHistorySource: z.string().optional(),
  sourceDisplay: SessionSourceDisplayMetadataSchema.optional(),
  importedAt: z.string().optional(),
  shareToken: z.string(),
  shareEndpointUrl: z.string().optional(),
});

const GuestImportedSessionSchema = z.object({
  session_id: z.string(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().optional(),
  name: z.string(),
  repoPath: z.string().optional(),
  category: z.string().optional(),
  agentIconId: z.string().optional(),
  agentDisplayName: z.string().optional(),
  pinned: z.boolean().optional(),
  importedFrom: GuestImportedFromSchema,
});

type GuestImportedSessionEntry = z.output<typeof GuestImportedSessionSchema>;

const GuestImportRegistrySchema = z.record(
  z.string(),
  GuestImportedSessionSchema
);

type GuestImportRegistry = z.output<typeof GuestImportRegistrySchema>;

function readRegistry(): GuestImportRegistry {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(GUEST_IMPORT_REGISTRY_STORAGE_KEY);
    if (!raw) return {};
    return GuestImportRegistrySchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeRegistry(registry: GuestImportRegistry): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      GUEST_IMPORT_REGISTRY_STORAGE_KEY,
      JSON.stringify(registry)
    );
  } catch {
    // Quota exceeded — same silent posture as the session list persistence.
  }
}

function toRegistryEntry(session: Session): GuestImportedSessionEntry | null {
  const parsed = GuestImportedSessionSchema.safeParse(session);
  return parsed.success ? parsed.data : null;
}

function toSession(entry: GuestImportedSessionEntry): Session {
  return entry as unknown as Session;
}

/** No-op unless the row carries a share-token capability (guest import). */
export function recordGuestImportedSession(session: Session): void {
  if (!session.importedFrom?.shareToken) return;
  const entry = toRegistryEntry(session);
  if (!entry) return;
  const registry = readRegistry();
  registry[session.session_id] = entry;
  const ids = Object.keys(registry);
  if (ids.length > MAX_REGISTRY_ENTRIES) {
    const oldestFirst = ids.sort((left, right) =>
      registry[left].updated_at.localeCompare(registry[right].updated_at)
    );
    for (const id of oldestFirst.slice(0, ids.length - MAX_REGISTRY_ENTRIES)) {
      delete registry[id];
    }
  }
  writeRegistry(registry);
}

export function removeGuestImportedSession(sessionId: string): void {
  const registry = readRegistry();
  if (!(sessionId in registry)) return;
  delete registry[sessionId];
  writeRegistry(registry);
}

/**
 * Re-materialize registry-backed guest rows that an authoritative load does
 * not know about. Rows already present (by id) win over the registry copy.
 */
export function mergeGuestImportedSessions(
  sessions: readonly Session[]
): Session[] {
  const registry = readRegistry();
  const entries = Object.values(registry);
  if (entries.length === 0) return sessions.slice();
  const presentIds = new Set(sessions.map((session) => session.session_id));
  const merged = sessions.slice();
  for (const entry of entries) {
    if (!presentIds.has(entry.session_id)) {
      merged.push(toSession(entry));
    }
  }
  return merged;
}

export const __GUEST_IMPORT_REGISTRY_INTERNALS = {
  GUEST_IMPORT_REGISTRY_STORAGE_KEY,
  MAX_REGISTRY_ENTRIES,
};
