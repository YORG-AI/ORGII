/**
 * Wire contract for the `org2_cloud` session-sync RPCs: the zod parsers plus
 * the client-side shapes they produce. No I/O lives here — the concern
 * siblings (`.listing`, `.events`, `.orgSettings`) own the calls.
 */
import { z } from "zod/v4";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

const CloudSegmentWireSchema = z
  .object({
    seq: z.number(),
    // 0006 storage offload: a frozen segment carries storagePath XOR the
    // legacy inline payloadGz. The tail (seq 0) is always inline.
    payloadGz: z.string().nullish(),
    storagePath: z.string().nullish(),
    eventCount: z.number(),
    segmentHash: z.string(),
  })
  .refine(
    (segment) => segment.payloadGz != null || segment.storagePath != null,
    { message: "segment carries neither payloadGz nor storagePath" }
  );

export const CloudSessionEventsSchema = z.object({
  epoch: z.number().nullish().default(null),
  frozenSeq: z.number().nullish().default(null),
  tailHash: z.string().nullish().default(null),
  count: z.number().nullish().default(null),
  segments: z.array(CloudSegmentWireSchema).default([]),
});

export const CloudSessionEventsPageSchema = CloudSessionEventsSchema.extend({
  nextAfterSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

/**
 * Keep each PostgREST response comfortably below the 15 s statement timeout.
 * One frozen segment is capped at 256 KiB before gzip. The server cap of 64
 * bounds a page to roughly 16 MiB of canonical event JSON while cutting a
 * gigabyte replay from ~100 network/IPC round trips to ~25.
 */
export const SESSION_EVENTS_PAGE_SIZE = 64;
/** Corruption/runaway guard: 65,536 frozen segments at the page size above. */
export const MAX_SESSION_EVENT_PAGES = 4_096;

const CloudCoolingScopeSchema = z.object({
  scopeKey: z.string(),
  /** ISO timestamp (UTC) when the cooling slot is reclaimed. */
  freesAt: z.string(),
});

export const CloudOrgScopeStateSchema = z.object({
  repoScopes: z.array(z.string()).default([]),
  /** Occupancy = active + cooling; can exceed `repoScopes.length`. */
  used: z
    .number()
    .nullish()
    .transform((value) => value ?? 0),
  /** null ⇒ unlimited. */
  cap: z.number().nullish().default(null),
  cooldownDays: z
    .number()
    .nullish()
    .transform((value) => value ?? 0),
  coolingDown: z.array(CloudCoolingScopeSchema).default([]),
});

export const CloudOrgSessionsSchema = z.object({
  serverTime: z.string().optional(),
  // Per-row tolerance: one malformed row (a newer client's shape, a bad
  // owner payload) must cost that row, not the whole org listing — a failed
  // listing reads as "org has no sessions" downstream, which the sidebar,
  // background upload and the retract sweep treat as authoritative absence.
  sessions: z.array(z.unknown()).default([]),
  // 0005 backends return a keyset cursor when a bounded page has more rows;
  // absent on legacy backends and on the final page. `.catch(undefined)`
  // degrades a malformed cursor to "no more pages" instead of failing the
  // whole listing parse.
  nextCursor: z
    .object({ updatedAt: z.string(), sessionId: z.string() })
    .nullish()
    .catch(undefined),
});

/** Read-side segment wire: inline (`payloadGz`) or offloaded (`storagePath`). */
export interface CloudSegmentWire {
  seq?: number;
  payloadGz?: string | null;
  storagePath?: string | null;
  eventCount: number;
  segmentHash: string;
}

export interface CloudSessionEventsSnapshot {
  epoch: number | null;
  frozenSeq: number | null;
  tailHash: string | null;
  /** Total event count (frozen + tail); null ⇒ nothing published yet. */
  count: number | null;
  segments: CloudSegmentWire[];
}

export type CloudSessionEventsSummary = Omit<
  CloudSessionEventsSnapshot,
  "segments"
>;

export interface CloudOrgSessions {
  serverTime?: string;
  sessions: RemoteTeammateSessionMetadata[];
}

export type CloudOrgScopeState = z.output<typeof CloudOrgScopeStateSchema>;
