/**
 * Canonical segment wire codec used by managed ORG2 Cloud and the shared
 * collaboration import/fork machinery.
 */
import { z } from "zod/v4";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { SessionEventsSegmentInput } from "./CollabSyncBackend";
import {
  computeSegmentHashFromBytes,
  gunzipBase64ToJson,
  gunzipBytesToJson,
  gzipBytes,
  gzipBytesToBase64,
  segmentCanonicalBytes,
} from "./collabGzip";

/** Wire shape of one segment inside the append/rewrite RPC body. */
export interface SegmentWirePayload {
  seq?: number;
  payloadGz: string;
  eventCount: number;
  segmentHash: string;
}

/** Raw-gzip encode of one frozen segment for a Storage object upload. */
export interface SegmentStoragePayload {
  seq: number;
  bytes: Uint8Array;
  eventCount: number;
  segmentHash: string;
}

export async function toFrozenSegmentWire(
  segment: SessionEventsSegmentInput
): Promise<SegmentWirePayload> {
  // One canonical encode per segment: the same UTF-8 bytes feed both the
  // gzip payload and segment_hash instead of stringifying twice.
  const bytes = segmentCanonicalBytes(segment.events);
  return {
    seq: segment.seq,
    payloadGz: await gzipBytesToBase64(bytes),
    eventCount: segment.events.length,
    segmentHash: await computeSegmentHashFromBytes(bytes),
  };
}

export async function toFrozenSegmentStorage(
  segment: SessionEventsSegmentInput
): Promise<SegmentStoragePayload> {
  const bytes = segmentCanonicalBytes(segment.events);
  return {
    seq: segment.seq,
    bytes: await gzipBytes(bytes),
    eventCount: segment.events.length,
    segmentHash: await computeSegmentHashFromBytes(bytes),
  };
}

export async function toTailWire(
  tail: SessionEvent[] | null
): Promise<Omit<SegmentWirePayload, "seq"> | null> {
  if (!tail || tail.length === 0) return null;
  const bytes = segmentCanonicalBytes(tail);
  return {
    payloadGz: await gzipBytesToBase64(bytes),
    eventCount: tail.length,
    segmentHash: await computeSegmentHashFromBytes(bytes),
  };
}

export async function decodeSegmentEvents(
  payloadGz: string
): Promise<SessionEvent[]> {
  return z
    .array(z.custom<SessionEvent>())
    .parse(await gunzipBase64ToJson(payloadGz));
}

export async function decodeSegmentEventsFromBytes(
  bytes: Uint8Array
): Promise<SessionEvent[]> {
  return z
    .array(z.custom<SessionEvent>())
    .parse(await gunzipBytesToJson(bytes));
}

/**
 * Codec-side concurrency budget. Encoding/decoding every segment through
 * `Promise.all` materializes all canonical byte buffers, gzip streams and
 * base64 strings at once — for a 20 MiB transcript that alone multiplies
 * renderer RSS. A small worker pool keeps at most this many segment codecs
 * in flight while preserving input order.
 */
const SEGMENT_CODEC_CONCURRENCY = 4;

/** Order-preserving bounded-concurrency map for segment encode/decode. */
export async function mapSegmentsBounded<T, R>(
  items: readonly T[],
  operation: (item: T) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(SEGMENT_CODEC_CONCURRENCY, items.length) },
    async () => {
      for (;;) {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        const index = nextIndex;
        if (index >= items.length) return;
        nextIndex += 1;
        results[index] = await operation(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
