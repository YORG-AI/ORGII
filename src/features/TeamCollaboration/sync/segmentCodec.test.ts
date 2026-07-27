import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { computeSegmentHash } from "./collabGzip";
import {
  decodeSegmentEvents,
  decodeSegmentEventsFromBytes,
  mapSegmentsBounded,
  toFrozenSegmentStorage,
  toFrozenSegmentWire,
  toTailWire,
} from "./segmentCodec";

function makeEvent(id: string): SessionEvent {
  return {
    id,
    displayStatus: "completed",
    payload: { text: `event ${id}` },
  } as unknown as SessionEvent;
}

describe("segmentCodec", () => {
  it("builds a frozen segment wire payload that round-trips", async () => {
    const events = [makeEvent("e1"), makeEvent("e2")];
    const wire = await toFrozenSegmentWire({ seq: 3, events });

    expect(wire.seq).toBe(3);
    expect(wire.eventCount).toBe(2);
    expect(wire.segmentHash).toBe(await computeSegmentHash(events));
    expect(await decodeSegmentEvents(wire.payloadGz)).toEqual(events);
  });

  it("builds a raw-gzip storage payload that round-trips and matches the inline hash", async () => {
    const events = [makeEvent("e1"), makeEvent("e2")];
    const stored = await toFrozenSegmentStorage({ seq: 3, events });

    expect(stored.seq).toBe(3);
    expect(stored.eventCount).toBe(2);
    expect(stored.segmentHash).toBe(await computeSegmentHash(events));
    expect(await decodeSegmentEventsFromBytes(stored.bytes)).toEqual(events);
    const wire = await toFrozenSegmentWire({ seq: 3, events });
    expect(stored.segmentHash).toBe(wire.segmentHash);
  });

  it("builds a tail wire payload without a seq", async () => {
    const events = [makeEvent("t1")];
    const wire = await toTailWire(events);

    expect(wire).not.toBeNull();
    expect(wire).not.toHaveProperty("seq");
    expect(wire?.eventCount).toBe(1);
    expect(wire?.segmentHash).toBe(await computeSegmentHash(events));
    expect(await decodeSegmentEvents(wire!.payloadGz)).toEqual(events);
  });

  it("returns null for an empty or missing tail", async () => {
    expect(await toTailWire(null)).toBeNull();
    expect(await toTailWire([])).toBeNull();
  });

  it("hashes exactly the shipped canonical bytes (idempotency contract)", async () => {
    const events = [makeEvent("e1")];
    const first = await toFrozenSegmentWire({ seq: 1, events });
    const second = await toFrozenSegmentWire({ seq: 1, events });
    expect(first.segmentHash).toBe(second.segmentHash);
    expect(first.payloadGz).toBe(second.payloadGz);
  });

  it("mapSegmentsBounded stops scheduling work once the signal aborts", async () => {
    const controller = new AbortController();
    const processed: number[] = [];

    await expect(
      mapSegmentsBounded(
        [1, 2, 3, 4, 5, 6, 7, 8],
        async (item: number) => {
          processed.push(item);
          if (processed.length >= 4) controller.abort();
          return item;
        },
        controller.signal
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );

    expect(processed.length).toBeLessThan(8);
  });

  it("mapSegmentsBounded rejects immediately on a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = async (item: number) => item;

    await expect(
      mapSegmentsBounded([1, 2, 3], operation, controller.signal)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );
  });
});
