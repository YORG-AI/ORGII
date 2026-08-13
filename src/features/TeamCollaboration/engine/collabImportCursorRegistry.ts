/**
 * Durable member-import replay cursors (restream-churn guard).
 *
 * The import cursor's only other home is `Session.importedFrom` on the
 * sessionsAtom row, whose localStorage snapshot keeps only the ~200 most
 * recently active sessions. An imported replay that falls out of that window
 * loses its cursor, and the next refresh then treats a fully-synced local
 * copy as a first import: clear + full restream. With hundreds of imported
 * team sessions this turned refreshes into whole-session DELETE+INSERT
 * sweeps — gigabytes of sqlite churn per day (events + FTS double-write),
 * and the matching full-event-set allocations in the Rust process.
 *
 * This registry is the cursor's durable home, keyed by the deterministic
 * local session id and consulted whenever the atom row is missing or carries
 * no usable cursor. Entries are tiny; identity fields are stored so a hit is
 * honored only for the exact (endpoint, org, source session) it described.
 *
 * Same durability posture as the guest-share registry: zod-validated
 * localStorage, corrupt payloads silently reset, bounded size with
 * oldest-write eviction.
 */
import { z } from "zod/v4";

const IMPORT_CURSOR_REGISTRY_STORAGE_KEY = "orgii:collabImportCursors:v1";

const MAX_REGISTRY_ENTRIES = 600;

const ImportCursorEntrySchema = z.object({
  orgId: z.string(),
  sourceSessionId: z.string(),
  sourceEndpointUrl: z.string().optional(),
  epoch: z.number(),
  seq: z.number(),
  count: z.number(),
  frozenCount: z.number().optional(),
  tailHash: z.string().optional(),
  updatedAtMs: z.number(),
});

export type ImportCursorEntry = z.output<typeof ImportCursorEntrySchema>;

const ImportCursorRegistrySchema = z.record(
  z.string(),
  ImportCursorEntrySchema
);

type ImportCursorRegistry = z.output<typeof ImportCursorRegistrySchema>;

export interface ImportCursorIdentity {
  orgId: string;
  sourceSessionId: string;
  sourceEndpointUrl?: string;
}

// In-process cache: the engine refreshes every imported session per pass,
// and each refresh consults the registry — re-parsing a ~100KB JSON map
// hundreds of times per pass would trade the disk churn this module removes
// for CPU churn. localStorage stays the source of truth; a concurrent
// process's write is at worst a stale read here, which costs one extra
// restream, never data.
let registryCache: ImportCursorRegistry | null = null;

function readRegistry(): ImportCursorRegistry {
  if (registryCache) return registryCache;
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(IMPORT_CURSOR_REGISTRY_STORAGE_KEY);
    registryCache = raw
      ? ImportCursorRegistrySchema.parse(JSON.parse(raw))
      : {};
  } catch {
    registryCache = {};
  }
  return registryCache;
}

function writeRegistry(registry: ImportCursorRegistry): void {
  registryCache = registry;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      IMPORT_CURSOR_REGISTRY_STORAGE_KEY,
      JSON.stringify(registry)
    );
  } catch {
    // Quota exceeded: the registry is an optimization, never a correctness
    // dependency — a dropped write costs one future restream, not data.
  }
}

/** Cursor for the local session id, honored only when the identity matches. */
export function readImportCursor(
  localSessionId: string,
  identity: ImportCursorIdentity
): ImportCursorEntry | null {
  const entry = readRegistry()[localSessionId];
  if (!entry) return null;
  if (
    entry.orgId !== identity.orgId ||
    entry.sourceSessionId !== identity.sourceSessionId ||
    (entry.sourceEndpointUrl ?? null) !== (identity.sourceEndpointUrl ?? null)
  ) {
    return null;
  }
  return entry;
}

export function recordImportCursor(
  localSessionId: string,
  entry: Omit<ImportCursorEntry, "updatedAtMs">
): void {
  const registry = readRegistry();
  const previous = registry[localSessionId];
  if (
    previous &&
    previous.orgId === entry.orgId &&
    previous.sourceSessionId === entry.sourceSessionId &&
    (previous.sourceEndpointUrl ?? null) ===
      (entry.sourceEndpointUrl ?? null) &&
    previous.epoch === entry.epoch &&
    previous.seq === entry.seq &&
    previous.count === entry.count &&
    (previous.frozenCount ?? null) === (entry.frozenCount ?? null) &&
    (previous.tailHash ?? null) === (entry.tailHash ?? null)
  ) {
    return;
  }
  registry[localSessionId] = { ...entry, updatedAtMs: Date.now() };
  const keys = Object.keys(registry);
  if (keys.length > MAX_REGISTRY_ENTRIES) {
    keys
      .sort(
        (keyA, keyB) => registry[keyA].updatedAtMs - registry[keyB].updatedAtMs
      )
      .slice(0, keys.length - MAX_REGISTRY_ENTRIES)
      .forEach((key) => delete registry[key]);
  }
  writeRegistry(registry);
}

export function clearImportCursor(localSessionId: string): void {
  const registry = readRegistry();
  if (!(localSessionId in registry)) return;
  delete registry[localSessionId];
  writeRegistry(registry);
}

export const __IMPORT_CURSOR_REGISTRY_INTERNALS = {
  IMPORT_CURSOR_REGISTRY_STORAGE_KEY,
  MAX_REGISTRY_ENTRIES,
  resetCacheForTests: (): void => {
    registryCache = null;
  },
};
