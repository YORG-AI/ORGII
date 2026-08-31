import { afterEach, describe, expect, it } from "vitest";

import {
  getChatRenderedTreeMemoryStats,
  registerChatRenderedTreeMemoryEntry,
} from "./runtimeMemoryStats";

describe("chat rendered-tree memory diagnostics", () => {
  let unregister: (() => void) | null = null;

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it("reads and normalizes the latest entry only when statistics are requested", () => {
    let reads = 0;
    let current = { bytes: 10.4, items: 2.6, label: "session-1" };
    unregister = registerChatRenderedTreeMemoryEntry(Symbol("test"), () => {
      reads += 1;
      return current;
    });

    expect(reads).toBe(0);
    expect(getChatRenderedTreeMemoryStats()).toEqual({
      bytes: 10,
      entries: 1,
      items: 3,
      topEntries: [{ bytes: 10, items: 3, label: "session-1" }],
    });
    expect(reads).toBe(1);

    current = { bytes: 25.8, items: 4.2, label: "session-2" };
    expect(getChatRenderedTreeMemoryStats()).toEqual({
      bytes: 26,
      entries: 1,
      items: 4,
      topEntries: [{ bytes: 26, items: 4, label: "session-2" }],
    });
    expect(reads).toBe(2);

    unregister();
    unregister = null;
    expect(getChatRenderedTreeMemoryStats()).toEqual({
      bytes: 0,
      entries: 0,
      items: 0,
      topEntries: [],
    });
  });
});
