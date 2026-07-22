/**
 * Versioned continuation wire for a single SessionEvent that cannot fit in
 * the legacy `SessionEvent[]` cloud segment budget.
 *
 * The server keeps treating `payloadGz` as opaque bytes. Physical attachment
 * rows use `eventCount = 0` until the final part and `eventCount = 1` on the
 * final part, so the existing server-side total remains a logical event count
 * while `seq` remains a physical, resumable row cursor.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  computeSegmentHash,
  computeSegmentHashFromBytes,
  gunzipBase64ToBytes,
  gzipBytesToBase64,
  segmentCanonicalBytes,
} from "./collabGzip";
import type { SegmentWirePayload } from "./segmentCodec";

const FRAME_MAGIC = new TextEncoder().encode("ORGII-REPLAY-ATTACHMENT-V2\0");
const FRAME_PREFIX_BYTES = FRAME_MAGIC.length + 4;
const ATTACHMENT_CHUNK_BYTES = 176 * 1024;
export const REPLAY_ATTACHMENT_WIRE_MAX_BYTES = 256 * 1024;

export interface ReplayAttachmentV2FrameHeader {
  kind: "event";
  attachmentId: string;
  partIndex: number;
  chunkOffset: number;
  chunkBytes: number;
  finalPart: boolean;
  eventBytes?: number;
  attachmentHash?: string;
}

interface PendingAttachment {
  readonly attachmentId: string;
  readonly chunks: Uint8Array[];
  nextPartIndex: number;
  nextOffset: number;
}

/** Reference-decoder row used by codec differential tests only. */
export interface DecodedReplaySegmentRecord {
  seq: number;
  isTail: boolean;
  events: SessionEvent[];
  eventCount: number;
  segmentHash: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    false
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(
    0,
    value,
    false
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseFrameHeader(value: unknown): ReplayAttachmentV2FrameHeader {
  if (!value || typeof value !== "object") {
    throw new Error("Replay attachment V2 header is not an object");
  }
  const header = value as Record<string, unknown>;
  const finalPart = header.finalPart === true;
  if (
    header.kind !== "event" ||
    typeof header.attachmentId !== "string" ||
    header.attachmentId.length === 0 ||
    !isSafeNonNegativeInteger(header.partIndex) ||
    !isSafeNonNegativeInteger(header.chunkOffset) ||
    !isSafeNonNegativeInteger(header.chunkBytes) ||
    typeof header.finalPart !== "boolean" ||
    (finalPart &&
      (!isSafeNonNegativeInteger(header.eventBytes) ||
        typeof header.attachmentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(header.attachmentHash))) ||
    (!finalPart &&
      (header.eventBytes !== undefined || header.attachmentHash !== undefined))
  ) {
    throw new Error("Replay attachment V2 header failed validation");
  }
  return header as unknown as ReplayAttachmentV2FrameHeader;
}

/** Canonical decompressed frame bytes shared with the Rust cloud spool. */
export function encodeReplayAttachmentV2Frame(
  header: ReplayAttachmentV2FrameHeader,
  chunk: Uint8Array
): Uint8Array {
  const headerBytes = segmentCanonicalBytes(header);
  const frame = new Uint8Array(
    FRAME_PREFIX_BYTES + headerBytes.byteLength + chunk.byteLength
  );
  frame.set(FRAME_MAGIC, 0);
  writeU32(frame, FRAME_MAGIC.length, headerBytes.byteLength);
  frame.set(headerBytes, FRAME_PREFIX_BYTES);
  frame.set(chunk, FRAME_PREFIX_BYTES + headerBytes.byteLength);
  return frame;
}

function decodeFrame(bytes: Uint8Array): {
  header: ReplayAttachmentV2FrameHeader;
  chunk: Uint8Array;
} {
  if (!startsWith(bytes, FRAME_MAGIC) || bytes.length < FRAME_PREFIX_BYTES) {
    throw new Error("Replay attachment V2 frame has an invalid magic prefix");
  }
  const headerBytes = readU32(bytes, FRAME_MAGIC.length);
  const payloadOffset = FRAME_PREFIX_BYTES + headerBytes;
  if (headerBytes === 0 || payloadOffset > bytes.length) {
    throw new Error("Replay attachment V2 frame header is truncated");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(FRAME_PREFIX_BYTES, payloadOffset)
      )
    ) as unknown;
  } catch (error) {
    throw errorWithCause(
      "Replay attachment V2 frame header is invalid JSON",
      error
    );
  }
  const header = parseFrameHeader(parsed);
  const chunk = bytes.subarray(payloadOffset);
  if (
    chunk.byteLength !== header.chunkBytes ||
    (header.finalPart &&
      header.chunkOffset + header.chunkBytes !== header.eventBytes)
  ) {
    throw new Error("Replay attachment V2 chunk length is inconsistent");
  }
  return { header, chunk };
}

function concatChunks(
  chunks: readonly Uint8Array[],
  totalBytes: number
): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== totalBytes) {
    throw new Error("Replay attachment V2 total length is incomplete");
  }
  return output;
}

function parseSessionEvent(bytes: Uint8Array): SessionEvent {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
  } catch (error) {
    throw errorWithCause("Replay attachment V2 event is invalid JSON", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Replay attachment V2 payload is not a SessionEvent object"
    );
  }
  return value as SessionEvent;
}

/** Test/reference encoder. Production external replay uses the Rust spool. */
export async function encodeReplayAttachmentV2(
  event: SessionEvent,
  startingSeq: number
): Promise<SegmentWirePayload[]> {
  if (!Number.isSafeInteger(startingSeq) || startingSeq < 1) {
    throw new Error("Replay attachment V2 requires a positive starting seq");
  }
  const eventBytes = segmentCanonicalBytes(event);
  const attachmentHash = await computeSegmentHashFromBytes(eventBytes);
  const attachmentId = await computeSegmentHashFromBytes(
    new TextEncoder().encode(event.id)
  );
  const partCount = Math.max(
    1,
    Math.ceil(eventBytes.byteLength / ATTACHMENT_CHUNK_BYTES)
  );
  const wires: SegmentWirePayload[] = [];
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const chunkOffset = partIndex * ATTACHMENT_CHUNK_BYTES;
    const chunk = eventBytes.subarray(
      chunkOffset,
      Math.min(eventBytes.byteLength, chunkOffset + ATTACHMENT_CHUNK_BYTES)
    );
    const frame = encodeReplayAttachmentV2Frame(
      {
        kind: "event",
        attachmentId,
        partIndex,
        chunkOffset,
        chunkBytes: chunk.byteLength,
        finalPart: partIndex === partCount - 1,
        ...(partIndex === partCount - 1
          ? {
              eventBytes: eventBytes.byteLength,
              attachmentHash,
            }
          : {}),
      },
      chunk
    );
    const wire: SegmentWirePayload = {
      seq: startingSeq + partIndex,
      payloadGz: await gzipBytesToBase64(frame),
      eventCount: partIndex === partCount - 1 ? 1 : 0,
      segmentHash: await computeSegmentHashFromBytes(frame),
    };
    const wireBytes = segmentCanonicalBytes(wire).byteLength;
    if (wireBytes > REPLAY_ATTACHMENT_WIRE_MAX_BYTES) {
      throw new Error(
        `Replay attachment V2 wire is ${wireBytes} bytes (limit ${REPLAY_ATTACHMENT_WIRE_MAX_BYTES})`
      );
    }
    wires.push(wire);
  }
  return wires;
}

/**
 * Decode a mixed V1/V2 physical snapshot in order. V2 parts are processed one
 * row at a time; only the one logical event being completed is accumulated.
 */
export async function decodeReplaySegmentWires(
  wires: readonly SegmentWirePayload[],
  signal?: AbortSignal
): Promise<DecodedReplaySegmentRecord[]> {
  const ordered = [...wires].sort((left, right) => {
    const leftSeq = left.seq ?? 0;
    const rightSeq = right.seq ?? 0;
    if (leftSeq === 0) return rightSeq === 0 ? 0 : 1;
    if (rightSeq === 0) return -1;
    return leftSeq - rightSeq;
  });
  const records: DecodedReplaySegmentRecord[] = [];
  let pending: PendingAttachment | null = null;
  let emptySegmentHash: string | null = null;

  for (const wire of ordered) {
    throwIfAborted(signal);
    const seq = wire.seq ?? 0;
    const decoded = await gunzipBase64ToBytes(wire.payloadGz);
    if (!startsWith(decoded, FRAME_MAGIC)) {
      if (pending) {
        throw new Error("Replay attachment V2 is missing continuation parts");
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(decoded)) as unknown;
      } catch (error) {
        throw errorWithCause("Legacy replay segment is invalid JSON", error);
      }
      if (!Array.isArray(value)) {
        throw new Error("Legacy replay segment payload is not an event array");
      }
      records.push({
        seq,
        isTail: seq === 0,
        events: value as SessionEvent[],
        eventCount: wire.eventCount,
        segmentHash: wire.segmentHash,
      });
      continue;
    }

    if (seq === 0) {
      throw new Error(
        "Replay attachment V2 must use frozen rows; mutable tails require an epoch rewrite"
      );
    }
    if ((await computeSegmentHashFromBytes(decoded)) !== wire.segmentHash) {
      throw new Error("Replay attachment V2 physical frame hash mismatch");
    }
    const { header, chunk } = decodeFrame(decoded);
    if (header.partIndex === 0) {
      if (pending) {
        throw new Error(
          "Replay attachment V2 started before the prior event completed"
        );
      }
      pending = {
        attachmentId: header.attachmentId,
        chunks: [],
        nextPartIndex: 0,
        nextOffset: 0,
      };
    }
    if (
      !pending ||
      header.attachmentId !== pending.attachmentId ||
      header.partIndex !== pending.nextPartIndex ||
      header.chunkOffset !== pending.nextOffset
    ) {
      throw new Error("Replay attachment V2 parts are missing or out of order");
    }
    const finalPart = header.finalPart;
    if (wire.eventCount !== (finalPart ? 1 : 0)) {
      throw new Error(
        "Replay attachment V2 physical eventCount is inconsistent"
      );
    }
    pending.chunks.push(chunk);
    pending.nextPartIndex += 1;
    pending.nextOffset += chunk.byteLength;

    if (!finalPart) {
      emptySegmentHash ??= await computeSegmentHash([]);
      records.push({
        seq,
        isTail: false,
        events: [],
        eventCount: 0,
        segmentHash: emptySegmentHash,
      });
      continue;
    }

    const eventBytes = header.eventBytes;
    const attachmentHash = header.attachmentHash;
    if (eventBytes === undefined || attachmentHash === undefined) {
      throw new Error("Replay attachment V2 final metadata is missing");
    }
    const completeBytes = concatChunks(pending.chunks, eventBytes);
    if ((await computeSegmentHashFromBytes(completeBytes)) !== attachmentHash) {
      throw new Error("Replay attachment V2 complete event hash mismatch");
    }
    const event = parseSessionEvent(completeBytes);
    records.push({
      seq,
      isTail: false,
      events: [event],
      eventCount: 1,
      segmentHash: await computeSegmentHash([event]),
    });
    pending = null;
  }

  if (pending) {
    throw new Error("Replay attachment V2 is missing its final part");
  }
  return records;
}
