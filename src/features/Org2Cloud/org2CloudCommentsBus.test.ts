import { describe, expect, it } from "vitest";

import {
  MAX_COMMENTS_SIGNAL_KEYS,
  bumpCommentsSignalKey,
} from "./org2CloudCommentsBus";

describe("bumpCommentsSignalKey", () => {
  it("bumps a missing key to 1 and an existing key by 1", () => {
    const first = bumpCommentsSignalKey({}, "org-1|session-1");
    expect(first).toEqual({ "org-1|session-1": 1 });
    const second = bumpCommentsSignalKey(first, "org-1|session-1");
    expect(second).toEqual({ "org-1|session-1": 2 });
  });

  it("does not mutate the input record", () => {
    const input = { "org-1|session-1": 3 };
    bumpCommentsSignalKey(input, "org-1|session-1");
    expect(input).toEqual({ "org-1|session-1": 3 });
  });

  it("caps the record at MAX_COMMENTS_SIGNAL_KEYS by evicting the oldest key", () => {
    let record: Record<string, number> = {};
    for (let index = 0; index < MAX_COMMENTS_SIGNAL_KEYS; index += 1) {
      record = bumpCommentsSignalKey(record, `org-1|session-${index}`);
    }
    expect(Object.keys(record)).toHaveLength(MAX_COMMENTS_SIGNAL_KEYS);

    record = bumpCommentsSignalKey(record, "org-1|overflow");
    expect(Object.keys(record)).toHaveLength(MAX_COMMENTS_SIGNAL_KEYS);
    expect(record["org-1|session-0"]).toBeUndefined();
    expect(record["org-1|overflow"]).toBe(1);
  });

  it("treats a re-bumped key as most recently used (survives the next eviction)", () => {
    let record: Record<string, number> = {};
    for (let index = 0; index < MAX_COMMENTS_SIGNAL_KEYS; index += 1) {
      record = bumpCommentsSignalKey(record, `org-1|session-${index}`);
    }
    // Refresh the would-be-oldest key, then overflow: session-1 (now the
    // oldest untouched key) must be evicted instead of session-0.
    record = bumpCommentsSignalKey(record, "org-1|session-0");
    record = bumpCommentsSignalKey(record, "org-1|overflow");
    expect(record["org-1|session-0"]).toBe(2);
    expect(record["org-1|session-1"]).toBeUndefined();
  });
});
