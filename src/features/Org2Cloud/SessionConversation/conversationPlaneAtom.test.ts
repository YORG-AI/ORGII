import { describe, expect, it } from "vitest";

import {
  type ConversationPlaneEntry,
  MAX_TRACKED_CONVERSATIONS,
  setPlaneEntry,
} from "./conversationPlaneAtom";

const entry = (lastSeq: number): ConversationPlaneEntry => ({
  state: "ready",
  events: [],
  lastSeq,
});

function fill(count: number): Record<string, ConversationPlaneEntry> {
  let entries: Record<string, ConversationPlaneEntry> = {};
  for (let index = 0; index < count; index += 1) {
    entries = setPlaneEntry(entries, `conversation-${index}`, entry(index));
  }
  return entries;
}

describe("setPlaneEntry", () => {
  it("writes the entry through unchanged", () => {
    const entries = setPlaneEntry({}, "a", entry(7));
    expect(entries.a).toEqual(entry(7));
  });

  it("holds at the cap instead of growing per conversation opened", () => {
    // The regression this guards: one entry per conversation ever opened,
    // each carrying that conversation's whole event list, kept forever.
    const entries = fill(MAX_TRACKED_CONVERSATIONS + 20);
    expect(Object.keys(entries)).toHaveLength(MAX_TRACKED_CONVERSATIONS);
  });

  it("evicts least-recently-written conversations first", () => {
    const entries = fill(MAX_TRACKED_CONVERSATIONS + 2);
    expect(entries["conversation-0"]).toBeUndefined();
    expect(entries["conversation-1"]).toBeUndefined();
    expect(entries["conversation-2"]).toBeDefined();
  });

  it("keeps a conversation alive when it is written again", () => {
    let entries = fill(MAX_TRACKED_CONVERSATIONS);
    // Re-writing conversation-0 moves it to the most-recent position, so the
    // next overflow takes conversation-1 instead.
    entries = setPlaneEntry(entries, "conversation-0", entry(99));
    entries = setPlaneEntry(entries, "fresh", entry(0));

    expect(entries["conversation-0"]).toEqual(entry(99));
    expect(entries["conversation-1"]).toBeUndefined();
  });

  it("never evicts the key currently being written", () => {
    const entries = setPlaneEntry(fill(MAX_TRACKED_CONVERSATIONS), "new", {
      state: "loading",
      events: [],
      lastSeq: 0,
    });
    expect(entries.new).toBeDefined();
    expect(Object.keys(entries)).toHaveLength(MAX_TRACKED_CONVERSATIONS);
  });

  it("does not mutate the record it is given", () => {
    const before = fill(3);
    const snapshot = { ...before };
    setPlaneEntry(before, "another", entry(1));
    expect(before).toEqual(snapshot);
  });
});
