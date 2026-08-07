/**
 * Canonical segment wire codec used by managed ORG2 Cloud and the shared
 * collaboration import/fork machinery.
 */
import { z } from "zod/v4";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { SessionEventsSegmentInput } from "./CollabSyncBackend";
import {
  computeSegmentHash,
  gunzipBase64ToJson,
  gzipJsonToBase64,
} from "./collabGzip";

/** Wire shape of one segment inside the append/rewrite RPC body. */
export interface SegmentWirePayload {
  seq?: number;
  payloadGz: string;
  eventCount: number;
  segmentHash: string;
}

export async function toFrozenSegmentWire(
  segment: SessionEventsSegmentInput
): Promise<SegmentWirePayload> {
  return {
    seq: segment.seq,
    payloadGz: await gzipJsonToBase64(segment.events),
    eventCount: segment.events.length,
    segmentHash: await computeSegmentHash(segment.events),
  };
}

export async function toTailWire(
  tail: SessionEvent[] | null
): Promise<Omit<SegmentWirePayload, "seq"> | null> {
  if (!tail || tail.length === 0) return null;
  return {
    payloadGz: await gzipJsonToBase64(tail),
    eventCount: tail.length,
    segmentHash: await computeSegmentHash(tail),
  };
}

export async function decodeSegmentEvents(
  payloadGz: string
): Promise<SessionEvent[]> {
  return z
    .array(z.custom<SessionEvent>())
    .parse(await gunzipBase64ToJson(payloadGz));
}
