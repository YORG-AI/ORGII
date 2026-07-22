import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  computeSegmentHash,
  computeSegmentHashFromBytes,
  gunzipBase64ToBytes,
  gzipBytesToBase64,
} from "./collabGzip";
import {
  REPLAY_ATTACHMENT_WIRE_MAX_BYTES,
  decodeReplaySegmentWires,
  encodeReplayAttachmentV2,
  encodeReplayAttachmentV2Frame,
} from "./replayAttachmentCodec";
import { toFrozenSegmentWire } from "./segmentCodec";

function makeEvent(id: string, text: string): SessionEvent {
  return {
    id,
    displayStatus: "completed",
    displayText: text,
  } as unknown as SessionEvent;
}

function deterministicHighEntropyAscii(bytes: number): string {
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let state = 0x9e3779b9;
  for (let offset = 0; offset < bytes; offset += 32 * 1024) {
    const chunk = new Uint8Array(Math.min(32 * 1024, bytes - offset));
    for (let index = 0; index < chunk.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      chunk[index] = 33 + ((state >>> 0) % 90);
    }
    pieces.push(decoder.decode(chunk));
  }
  return pieces.join("");
}

describe("Replay attachment V2", () => {
  it("matches the Rust frame-layout golden hash", async () => {
    const chunk = new TextEncoder().encode("abc");
    const frame = encodeReplayAttachmentV2Frame(
      {
        kind: "event",
        attachmentId:
          "dd56de4137951d9c92681b03416ec15f886b4482a27e3a517d32f085244cbe5d",
        partIndex: 0,
        chunkOffset: 0,
        chunkBytes: 3,
        finalPart: true,
        eventBytes: 3,
        attachmentHash:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
      chunk
    );
    expect(await computeSegmentHashFromBytes(frame)).toBe(
      "1cf7b415e8558ddb0d72bcf9212ff381c9a57bfd719628824a61e4a67bcf3126"
    );
  });

  it("losslessly round-trips one 10 MiB high-entropy event with every wire <= 256 KiB", async () => {
    const event = makeEvent(
      "huge-event",
      deterministicHighEntropyAscii(10 * 1024 * 1024)
    );
    const beforeHash = await computeSegmentHash([event]);
    const wires = await encodeReplayAttachmentV2(event, 7);

    expect(wires.length).toBeGreaterThan(1);
    expect(wires.reduce((sum, wire) => sum + wire.eventCount, 0)).toBe(1);
    for (const [index, wire] of wires.entries()) {
      expect(wire.seq).toBe(7 + index);
      expect(
        new TextEncoder().encode(JSON.stringify(wire)).byteLength
      ).toBeLessThanOrEqual(REPLAY_ATTACHMENT_WIRE_MAX_BYTES);
    }

    const records = await decodeReplaySegmentWires(wires);
    const events = records.flatMap((record) => record.events);
    expect(events).toHaveLength(1);
    expect(await computeSegmentHash(events)).toBe(beforeHash);
    expect(events[0].displayText.length).toBe(10 * 1024 * 1024);
  }, 60_000);

  it("decodes mixed legacy and attachment rows without changing V1", async () => {
    const before = makeEvent("before", "legacy");
    const huge = makeEvent("huge", deterministicHighEntropyAscii(400 * 1024));
    const after = makeEvent("after", "legacy");
    const first = await toFrozenSegmentWire({ seq: 1, events: [before] });
    const attachment = await encodeReplayAttachmentV2(huge, 2);
    const last = await toFrozenSegmentWire({
      seq: 2 + attachment.length,
      events: [after],
    });

    const records = await decodeReplaySegmentWires([
      last,
      ...attachment,
      first,
    ]);
    expect(records.flatMap((record) => record.events)).toEqual([
      before,
      huge,
      after,
    ]);
  });

  it("fails closed on a corrupt physical hash", async () => {
    const wires = await encodeReplayAttachmentV2(
      makeEvent("corrupt", deterministicHighEntropyAscii(300 * 1024)),
      1
    );
    const corrupted = wires.map((wire, index) =>
      index === 0 ? { ...wire, segmentHash: "0".repeat(64) } : wire
    );
    await expect(decodeReplaySegmentWires(corrupted)).rejects.toThrow(
      "physical frame hash mismatch"
    );
  });

  it("fails closed when a continuation part is missing", async () => {
    const wires = await encodeReplayAttachmentV2(
      makeEvent("missing", deterministicHighEntropyAscii(600 * 1024)),
      1
    );
    wires.splice(1, 1);
    await expect(decodeReplaySegmentWires(wires)).rejects.toThrow(
      "missing or out of order"
    );
  });

  it("fails closed when final attachment bytes do not match the complete hash", async () => {
    const wires = await encodeReplayAttachmentV2(
      makeEvent("corrupt-final", deterministicHighEntropyAscii(300 * 1024)),
      1
    );
    const finalIndex = wires.length - 1;
    const decoded = await gunzipBase64ToBytes(wires[finalIndex].payloadGz);
    decoded[decoded.length - 1] ^= 1;
    wires[finalIndex] = {
      ...wires[finalIndex],
      payloadGz: await gzipBytesToBase64(decoded),
      segmentHash: await computeSegmentHashFromBytes(decoded),
    };

    await expect(decodeReplaySegmentWires(wires)).rejects.toThrow(
      "complete event hash mismatch"
    );
  });

  it("fails closed when a continuation row reports a logical event", async () => {
    const wires = await encodeReplayAttachmentV2(
      makeEvent("wrong-count", deterministicHighEntropyAscii(300 * 1024)),
      1
    );
    wires[0] = { ...wires[0], eventCount: 1 };

    await expect(decodeReplaySegmentWires(wires)).rejects.toThrow(
      "physical eventCount is inconsistent"
    );
  });

  it("honors cancellation between physical rows", async () => {
    const wires = await encodeReplayAttachmentV2(
      makeEvent("abort", deterministicHighEntropyAscii(300 * 1024)),
      1
    );
    const controller = new AbortController();
    const decoding = decodeReplaySegmentWires(wires, controller.signal);
    // The first row has entered its async decode. Cancellation must be
    // observed before a second physical continuation is processed.
    controller.abort();
    await expect(decoding).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );
  });
});
