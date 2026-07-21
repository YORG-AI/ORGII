import { describe, expect, it } from "vitest";

import type {
  ApiCallHotspot,
  PushHotspot,
  TimerHotspot,
} from "@src/util/monitoring/apiTracker";

import {
  selectVisibleApiHotspots,
  selectVisiblePushHotspots,
  selectVisibleTimerHotspots,
} from "./PanelContent";

function hotspot(index: number, isLikelyPolling: boolean): ApiCallHotspot {
  return {
    key: `key-${index}`,
    transport: "http",
    method: "POST",
    target: `/rpc/${index}`,
    count: 3,
    callsPerMinute: 2,
    lastTimestamp: "2026-07-18T00:00:00.000Z",
    firstTimestamp: "2026-07-17T23:59:00.000Z",
    isLikelyPolling,
  };
}

describe("selectVisibleApiHotspots", () => {
  it("keeps the top six and every additional likely-polling group", () => {
    const hotspots = Array.from({ length: 10 }, (_, index) =>
      hotspot(index, index === 7 || index === 9)
    );

    expect(selectVisibleApiHotspots(hotspots).map((item) => item.key)).toEqual([
      "key-0",
      "key-1",
      "key-2",
      "key-3",
      "key-4",
      "key-5",
      "key-7",
      "key-9",
    ]);
  });
});

describe("expanded diagnostic summaries", () => {
  it("keeps likely timer loops beyond the first six", () => {
    const hotspots = Array.from({ length: 9 }, (_, index) => ({
      key: `timer-${index}`,
      kind: "interval",
      count: 3,
      firesPerMinute: 3,
      lastTimestamp: "2026-07-18T00:00:00.000Z",
      firstTimestamp: "2026-07-17T23:59:00.000Z",
      isLikelyLoop: index === 8,
    })) satisfies TimerHotspot[];

    expect(
      selectVisibleTimerHotspots(hotspots).map((item) => item.key)
    ).toEqual([
      "timer-0",
      "timer-1",
      "timer-2",
      "timer-3",
      "timer-4",
      "timer-5",
      "timer-8",
    ]);
  });

  it("keeps active streams beyond the first six", () => {
    const hotspots = Array.from({ length: 9 }, (_, index) => ({
      key: `push-${index}`,
      kind: "ws",
      name: `message-${index}`,
      count: 10,
      eventsPerMinute: 10,
      lastTimestamp: "2026-07-18T00:00:00.000Z",
      firstTimestamp: "2026-07-17T23:59:00.000Z",
      isLikelyStream: index === 7,
    })) satisfies PushHotspot[];

    expect(selectVisiblePushHotspots(hotspots).map((item) => item.key)).toEqual(
      ["push-0", "push-1", "push-2", "push-3", "push-4", "push-5", "push-7"]
    );
  });
});
