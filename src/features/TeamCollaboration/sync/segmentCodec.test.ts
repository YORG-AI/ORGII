import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { computeSegmentHash } from "./collabGzip";
import {
  decodeSegmentEvents,
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
});
