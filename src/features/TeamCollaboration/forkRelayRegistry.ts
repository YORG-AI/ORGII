/**
 * Durable fork-relay registry (provenance + one-shot handoff marker).
 *
 * Backend list reloads rebuild `Session` rows from Rust (which does not know
 * `forkedFrom`), so this localStorage registry is what keeps "⑂ taken over
 * from @owner" alive across reloads — and what arms the one-shot first-send
 * handoff consumed by `markForkHandoffConsumed`.
 *
 * Sole owner of the `orgii:collabForkRelay:v1` storage key.
 */
import { z } from "zod/v4";

import type {
  Session,
  SessionForkedFrom,
} from "@src/store/session/sessionAtom/types";

export const FORK_RELAY_STORAGE_KEY = "orgii:collabForkRelay:v1";

/** Registry size cap — evicts the oldest fork (by forkedAt) past this. */
export const MAX_REGISTRY_ENTRIES = 100;

const SessionForkedFromSchema = z.object({
  orgId: z.string(),
  sourceSessionId: z.string(),
  ownerMemberId: z.string(),
  ownerDisplayName: z.string(),
  atCount: z.number(),
  forkedAt: z.string(),
  rootSessionId: z.string().optional(),
}) satisfies z.ZodType<SessionForkedFrom>;

const ForkRelayEntrySchema = z.object({
  forkedFrom: SessionForkedFromSchema,
  /** True until the first successful message send consumes the handoff. */
  handoffPending: z.boolean(),
});

type ForkRelayEntry = z.output<typeof ForkRelayEntrySchema>;

const ForkRelayRegistrySchema = z.record(z.string(), ForkRelayEntrySchema);

type ForkRelayRegistry = z.output<typeof ForkRelayRegistrySchema>;

export function readRegistry(): ForkRelayRegistry {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(FORK_RELAY_STORAGE_KEY);
    if (!raw) return {};
    return ForkRelayRegistrySchema.parse(JSON.parse(raw));
  } catch {
    // Corrupt / legacy payload: fork provenance is a convenience, never a
    // reason to break the fork flow itself.
    return {};
  }
}

function writeRegistry(registry: ForkRelayRegistry): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FORK_RELAY_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // Quota exceeded — same silent posture as the session list persistence.
  }
}

export function writeRegistryEntry(
  sessionId: string,
  entry: ForkRelayEntry
): void {
  const registry = readRegistry();
  registry[sessionId] = entry;
  const ids = Object.keys(registry);
  if (ids.length > MAX_REGISTRY_ENTRIES) {
    const oldestFirst = ids.sort((left, right) =>
      registry[left].forkedFrom.forkedAt.localeCompare(
        registry[right].forkedFrom.forkedAt
      )
    );
    for (const id of oldestFirst.slice(0, ids.length - MAX_REGISTRY_ENTRIES)) {
      delete registry[id];
    }
  }
  writeRegistry(registry);
}

export function removeForkRelayEntry(sessionId: string): void {
  const registry = readRegistry();
  if (!(sessionId in registry)) return;
  delete registry[sessionId];
  writeRegistry(registry);
}

/**
 * Fork provenance for a session row — the read API for "⑂ taken over from
 * @owner" badges. Prefers the live `Session.forkedFrom` field and falls back
 * to the durable registry (list reloads rebuild rows from the backend, which
 * does not know the field).
 */
export function getSessionForkedFrom(
  session: Pick<Session, "session_id" | "forkedFrom">
): SessionForkedFrom | undefined {
  return session.forkedFrom ?? readRegistry()[session.session_id]?.forkedFrom;
}

/** Snapshot resolver for batch scans, avoiding one storage parse per row. */
export function createSessionForkedFromResolver(): (
  session: Pick<Session, "session_id" | "forkedFrom">
) => SessionForkedFrom | undefined {
  const registry = readRegistry();
  return (session) =>
    session.forkedFrom ?? registry[session.session_id]?.forkedFrom;
}

/** Consume the one-shot handoff after the wrapped send succeeded. */
export function markForkHandoffConsumed(sessionId: string): void {
  const registry = readRegistry();
  const entry = registry[sessionId];
  if (!entry?.handoffPending) return;
  registry[sessionId] = { ...entry, handoffPending: false };
  writeRegistry(registry);
}
