import { describe, expect, it } from "vitest";

import { sessionCommentsKey } from "./org2CloudCommentsBus";
import { Org2CloudCommentError } from "./org2CloudCommentsClient";
import type { CloudSessionComment } from "./org2CloudCommentsClient";
import {
  type CloudSessionCommentsEntry,
  MAX_SESSION_COMMENT_CACHE_ENTRIES,
  SESSION_COMMENTS_DELTA_OVERLAP_MS,
  countLiveComments,
  decideSessionCommentsFetch,
  getThreadResolution,
  groupCommentThreads,
  insertComment,
  isThreadResolved,
  mergeDeltaSessionComments,
  mergeFullSessionComments,
  mergePresentEventIdEntries,
  patchComment,
  sessionCommentsDeltaSince,
  sessionCommentsEntryForIdentity,
  shouldEvictSessionCommentsOnError,
  writeSessionCommentsEntry,
} from "./org2CloudSessionCommentsAtom";

let sequence = 0;

describe("session comment identity isolation", () => {
  const entry: CloudSessionCommentsEntry = {
    identityKey: "https://cloud.example.com|user-1",
    comments: [],
    viewerOwnsSession: true,
    state: "ready",
    fetchedAt: 1,
  };

  it("exposes cached bodies only to the endpoint/account that loaded them", () => {
    expect(
      sessionCommentsEntryForIdentity(entry, "https://cloud.example.com|user-1")
    ).toBe(entry);
    expect(
      sessionCommentsEntryForIdentity(entry, "https://cloud.example.com|user-2")
    ).toBeUndefined();
    expect(sessionCommentsEntryForIdentity(entry, null)).toBeUndefined();
  });

  it("bounds cached threads with least-recent eviction", () => {
    let entries: Record<string, CloudSessionCommentsEntry> = {};
    for (
      let index = 0;
      index <= MAX_SESSION_COMMENT_CACHE_ENTRIES;
      index += 1
    ) {
      entries = writeSessionCommentsEntry(entries, `org|session-${index}`, {
        ...entry,
        fetchedAt: index,
      });
    }
    expect(Object.keys(entries)).toHaveLength(
      MAX_SESSION_COMMENT_CACHE_ENTRIES
    );
    expect(entries["org|session-0"]).toBeUndefined();
  });
});

function comment(
  overrides: Partial<CloudSessionComment> & { id: string }
): CloudSessionComment {
  sequence += 1;
  return {
    authorUserId: "user-a",
    authorDisplayName: "Alice",
    body: `body of ${overrides.id}`,
    createdAt: `2026-07-07T10:${String(sequence).padStart(2, "0")}:00.000Z`,
    ...overrides,
  };
}

describe("groupCommentThreads", () => {
  it("buckets anchored / session-level / orphaned threads", () => {
    const comments = [
      comment({ id: "c1", eventId: "evt-present" }),
      comment({ id: "c2" }),
      comment({ id: "c3", eventId: "evt-dropped" }),
    ];
    const grouped = groupCommentThreads(comments, new Set(["evt-present"]));
    expect([...grouped.byEventId.keys()]).toEqual(["evt-present"]);
    expect(grouped.byEventId.get("evt-present")).toHaveLength(1);
    expect(grouped.sessionLevel.map((thread) => thread.top.id)).toEqual(["c2"]);
    // Anchor no longer in the replay stream (owner-side epoch rewrite):
    // degrade to the "earlier version" bucket, never crash or vanish.
    expect(grouped.orphaned.map((thread) => thread.top.id)).toEqual(["c3"]);
  });

  it("treats unknown presence (null) as present — no false orphans", () => {
    const grouped = groupCommentThreads(
      [comment({ id: "c1", eventId: "evt-1" })],
      null
    );
    expect(grouped.byEventId.get("evt-1")).toHaveLength(1);
    expect(grouped.orphaned).toEqual([]);
  });

  it("groups multiple threads under one anchor in (createdAt, id) order", () => {
    const comments = [
      comment({
        id: "c2",
        eventId: "evt-1",
        createdAt: "2026-07-07T02:00:00Z",
      }),
      comment({
        id: "c1",
        eventId: "evt-1",
        createdAt: "2026-07-07T01:00:00Z",
      }),
    ];
    const grouped = groupCommentThreads(comments, new Set(["evt-1"]));
    expect(
      grouped.byEventId.get("evt-1")?.map((thread) => thread.top.id)
    ).toEqual(["c1", "c2"]);
  });

  it("attaches replies to their thread head, ordered (createdAt, id)", () => {
    const comments = [
      comment({
        id: "top",
        eventId: "evt-1",
        createdAt: "2026-07-07T01:00:00Z",
      }),
      comment({
        id: "r2",
        parentId: "top",
        createdAt: "2026-07-07T03:00:00Z",
      }),
      comment({
        id: "r1",
        parentId: "top",
        createdAt: "2026-07-07T02:00:00Z",
      }),
      // Same timestamp: id is the deterministic tiebreak (server order).
      comment({
        id: "r3",
        parentId: "top",
        createdAt: "2026-07-07T03:00:00Z",
      }),
    ];
    const grouped = groupCommentThreads(comments, new Set(["evt-1"]));
    const thread = grouped.byEventId.get("evt-1")?.[0];
    expect(thread?.replies.map((reply) => reply.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });

  it("replies never bucket on their own — they inherit the parent anchor", () => {
    const comments = [
      comment({ id: "top" }), // session-level head
      comment({ id: "r1", parentId: "top" }),
    ];
    const grouped = groupCommentThreads(comments, new Set());
    expect(grouped.sessionLevel).toHaveLength(1);
    expect(grouped.sessionLevel[0].replies.map((reply) => reply.id)).toEqual([
      "r1",
    ]);
    expect(grouped.byEventId.size).toBe(0);
    expect(grouped.orphaned).toEqual([]);
  });

  it("keeps a tombstoned head whose replies are live (thread shape)", () => {
    const comments = [
      comment({
        id: "top",
        eventId: "evt-1",
        body: "",
        deletedAt: "2026-07-07T04:00:00Z",
      }),
      comment({ id: "r1", parentId: "top" }),
    ];
    const grouped = groupCommentThreads(comments, new Set(["evt-1"]));
    const thread = grouped.byEventId.get("evt-1")?.[0];
    expect(thread?.top.deletedAt).toBeTruthy();
    expect(thread?.top.body).toBe("");
    expect(thread?.replies).toHaveLength(1);
  });

  it("keeps tombstoned replies inside a live thread (rendered as deleted)", () => {
    const comments = [
      comment({ id: "top" }),
      comment({
        id: "r1",
        parentId: "top",
        body: "",
        deletedAt: "2026-07-07T04:00:00Z",
      }),
    ];
    const grouped = groupCommentThreads(comments, null);
    expect(grouped.sessionLevel[0].replies).toHaveLength(1);
    expect(grouped.sessionLevel[0].replies[0].deletedAt).toBeTruthy();
  });

  it("drops threads whose every member is a tombstone", () => {
    const comments = [
      comment({ id: "top", body: "", deletedAt: "2026-07-07T04:00:00Z" }),
      comment({
        id: "r1",
        parentId: "top",
        body: "",
        deletedAt: "2026-07-07T05:00:00Z",
      }),
      comment({ id: "solo", body: "", deletedAt: "2026-07-07T04:00:00Z" }),
    ];
    const grouped = groupCommentThreads(comments, null);
    expect(grouped.sessionLevel).toEqual([]);
    expect(grouped.byEventId.size).toBe(0);
    expect(grouped.orphaned).toEqual([]);
  });

  it("drops replies whose parent is missing (defensive, no crash)", () => {
    const grouped = groupCommentThreads(
      [comment({ id: "r1", parentId: "gone" })],
      null
    );
    expect(grouped.sessionLevel).toEqual([]);
    expect(grouped.byEventId.size).toBe(0);
    expect(grouped.orphaned).toEqual([]);
  });

  it("empty input yields empty buckets", () => {
    const grouped = groupCommentThreads([], new Set());
    expect(grouped.byEventId.size).toBe(0);
    expect(grouped.sessionLevel).toEqual([]);
    expect(grouped.orphaned).toEqual([]);
  });
});

describe("isThreadResolved (resolved filtering)", () => {
  it("keys on the thread head's resolvedAt only", () => {
    const open = groupCommentThreads([comment({ id: "c1" })], null)
      .sessionLevel[0];
    expect(isThreadResolved(open)).toBe(false);

    const resolved = groupCommentThreads(
      [
        comment({ id: "c2", resolvedAt: "2026-07-07T06:00:00Z" }),
        comment({ id: "r1", parentId: "c2" }),
      ],
      null
    ).sessionLevel[0];
    expect(isThreadResolved(resolved)).toBe(true);
    // Reply state never affects thread resolution.
    expect(resolved.replies).toHaveLength(1);
  });
});

describe("getThreadResolution", () => {
  it("null while active, verdict when resolved", () => {
    const active = groupCommentThreads([comment({ id: "c1" })], null)
      .sessionLevel[0];
    expect(getThreadResolution(active)).toBeNull();

    const wontFix = groupCommentThreads(
      [
        comment({
          id: "c2",
          resolvedAt: "2026-07-11T06:00:00Z",
          resolution: "wont_fix",
        }),
      ],
      null
    ).sessionLevel[0];
    expect(getThreadResolution(wontFix)).toBe("wont_fix");
  });

  it("a pre-delta resolved stamp without a verdict reads as 'resolved'", () => {
    const legacy = groupCommentThreads(
      [comment({ id: "c3", resolvedAt: "2026-07-11T06:00:00Z" })],
      null
    ).sessionLevel[0];
    expect(getThreadResolution(legacy)).toBe("resolved");
  });
});

describe("countLiveComments", () => {
  it("counts live heads and replies, skipping tombstones", () => {
    const grouped = groupCommentThreads(
      [
        comment({ id: "top", eventId: "evt-1" }),
        comment({ id: "r1", parentId: "top" }),
        comment({
          id: "r2",
          parentId: "top",
          body: "",
          deletedAt: "2026-07-07T04:00:00Z",
        }),
        comment({
          id: "top2",
          eventId: "evt-1",
          body: "",
          deletedAt: "2026-07-07T04:00:00Z",
        }),
        comment({ id: "r3", parentId: "top2" }),
      ],
      new Set(["evt-1"])
    );
    // top + r1 + r3 (tombstoned r2/top2 excluded).
    expect(countLiveComments(grouped.byEventId.get("evt-1") ?? [])).toBe(3);
  });
});

describe("insertComment / patchComment", () => {
  it("inserts in (createdAt, id) order and replaces duplicates by id", () => {
    const base = [
      comment({ id: "a", createdAt: "2026-07-07T01:00:00Z" }),
      comment({ id: "c", createdAt: "2026-07-07T03:00:00Z" }),
    ];
    const inserted = insertComment(
      base,
      comment({ id: "b", createdAt: "2026-07-07T02:00:00Z" })
    );
    expect(inserted.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    // Re-inserting an existing id replaces it (idempotent add retries).
    const replaced = insertComment(
      inserted,
      comment({ id: "b", createdAt: "2026-07-07T02:00:00Z", body: "updated" })
    );
    expect(replaced).toHaveLength(3);
    expect(replaced[1].body).toBe("updated");
  });

  it("patchComment maps the matching id and leaves the rest untouched", () => {
    const base = [comment({ id: "a" }), comment({ id: "b" })];
    const patched = patchComment(base, "b", {
      body: "",
      deletedAt: "2026-07-07T04:00:00Z",
    });
    expect(patched[0]).toEqual(base[0]);
    expect(patched[1].deletedAt).toBe("2026-07-07T04:00:00Z");
    expect(patched[1].body).toBe("");
    // Unknown id: structural no-op.
    expect(patchComment(base, "zzz", { body: "x" })).toEqual(base);
  });
});

describe("sessionCommentsDeltaSince", () => {
  it("subtracts the safety overlap from the stored anchor", () => {
    expect(sessionCommentsDeltaSince("2026-07-24T10:00:02.000Z")).toBe(
      new Date(
        Date.parse("2026-07-24T10:00:02.000Z") -
          SESSION_COMMENTS_DELTA_OVERLAP_MS
      ).toISOString()
    );
  });

  it("degrades an unparseable anchor to a full listing (undefined)", () => {
    expect(sessionCommentsDeltaSince("not-a-time")).toBeUndefined();
  });
});

describe("mergeDeltaSessionComments", () => {
  it("upserts stamped delta rows and keeps rows absent from the delta", () => {
    const existing = [
      comment({ id: "a", createdAt: "2026-07-24T01:00:00Z" }),
      comment({ id: "b", createdAt: "2026-07-24T02:00:00Z" }),
    ];
    const merged = mergeDeltaSessionComments(existing, [
      comment({
        id: "b",
        createdAt: "2026-07-24T02:00:00Z",
        editedAt: "2026-07-24T03:00:00Z",
        body: "edited remotely",
      }),
      comment({ id: "c", createdAt: "2026-07-24T04:00:00Z" }),
    ]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    // `a` was not in the delta: absence behind a cursor proves nothing.
    expect(merged[0]).toEqual(existing[0]);
    expect(merged[1].body).toBe("edited remotely");
  });

  it("LWW on the row's own stamps: a newer local write beats the overlap echo", () => {
    const localEdit = comment({
      id: "a",
      createdAt: "2026-07-24T01:00:00Z",
      editedAt: "2026-07-24T05:00:00Z",
      body: "local newer",
    });
    const merged = mergeDeltaSessionComments(
      [localEdit],
      [
        comment({
          id: "a",
          createdAt: "2026-07-24T01:00:00Z",
          editedAt: "2026-07-24T04:00:00Z",
          body: "stale echo",
        }),
      ]
    );
    expect(merged).toEqual([localEdit]);
  });

  it("takes the fetched row on equal stamps (server echo is authoritative)", () => {
    const merged = mergeDeltaSessionComments(
      [comment({ id: "a", createdAt: "2026-07-24T01:00:00Z", body: "local" })],
      [comment({ id: "a", createdAt: "2026-07-24T01:00:00Z", body: "server" })]
    );
    expect(merged[0].body).toBe("server");
  });

  it("delta tombstones drop the cached body", () => {
    const merged = mergeDeltaSessionComments(
      [comment({ id: "a", createdAt: "2026-07-24T01:00:00Z" })],
      [
        comment({
          id: "a",
          createdAt: "2026-07-24T01:00:00Z",
          deletedAt: "2026-07-24T02:00:00Z",
          body: "",
        }),
      ]
    );
    expect(merged[0].body).toBe("");
    expect(merged[0].deletedAt).toBe("2026-07-24T02:00:00Z");
  });

  it("cannot observe a stamp-free un-resolve (the documented delta gap)", () => {
    const resolvedLocally = comment({
      id: "a",
      createdAt: "2026-07-24T01:00:00Z",
      resolvedAt: "2026-07-24T03:00:00Z",
    });
    // The server row after un-resolve carries no stamp newer than createdAt,
    // so LWW keeps the locally cached resolved state — full listings own
    // this reconciliation.
    const merged = mergeDeltaSessionComments(
      [resolvedLocally],
      [comment({ id: "a", createdAt: "2026-07-24T01:00:00Z" })]
    );
    expect(merged[0].resolvedAt).toBe("2026-07-24T03:00:00Z");
  });
});

describe("mergeFullSessionComments", () => {
  it("reconciles an un-resolve: the snapshot row replaces the resolved cache", () => {
    const resolvedLocally = comment({
      id: "a",
      createdAt: "2026-07-24T01:00:00Z",
      resolvedAt: "2026-07-24T03:00:00Z",
    });
    const unresolvedOnServer = comment({
      id: "a",
      createdAt: "2026-07-24T01:00:00Z",
    });
    const merged = mergeFullSessionComments(
      [resolvedLocally],
      [unresolvedOnServer],
      new Set(["a"])
    );
    expect(merged).toEqual([unresolvedOnServer]);
    expect(merged[0].resolvedAt).toBeUndefined();
  });

  it("preserves optimistic adds the snapshot predates, drops server-deleted rows", () => {
    const optimistic = comment({
      id: "new",
      createdAt: "2026-07-24T05:00:00Z",
    });
    const erased = comment({ id: "gone", createdAt: "2026-07-24T01:00:00Z" });
    const kept = comment({ id: "kept", createdAt: "2026-07-24T02:00:00Z" });
    const merged = mergeFullSessionComments(
      [erased, kept, optimistic],
      [kept],
      new Set(["gone", "kept"])
    );
    expect(merged.map((entry) => entry.id)).toEqual(["kept", "new"]);
  });
});

describe("sessionCommentsKey", () => {
  it("namespaces org and session", () => {
    expect(sessionCommentsKey("org-1", "sess-1")).toBe("org-1|sess-1");
    expect(sessionCommentsKey("org-1", "sess-2")).not.toBe(
      sessionCommentsKey("org-2", "sess-2")
    );
  });
});

describe("decideSessionCommentsFetch — force is queued, never dropped", () => {
  const NOW = 1_751_900_000_000;

  function entry(
    overrides: Partial<CloudSessionCommentsEntry> = {}
  ): CloudSessionCommentsEntry {
    return {
      comments: [],
      viewerOwnsSession: false,
      state: "ready",
      fetchedAt: NOW,
      ...overrides,
    };
  }

  it("claims when no entry exists (first mount)", () => {
    expect(decideSessionCommentsFetch(undefined, false, NOW)).toBe("claim");
  });

  it("skips a non-forced call within the TTL, claims past it", () => {
    expect(decideSessionCommentsFetch(entry(), false, NOW + 1_000)).toBe(
      "skip"
    );
    expect(decideSessionCommentsFetch(entry(), false, NOW + 31_000)).toBe(
      "claim"
    );
  });

  it("a force bypasses the TTL", () => {
    expect(decideSessionCommentsFetch(entry(), true, NOW + 1_000)).toBe(
      "claim"
    );
  });

  it("an error entry becomes re-claimable after the short retry window", () => {
    const errored = entry({ state: "error" });
    expect(decideSessionCommentsFetch(errored, false, NOW + 1_000)).toBe(
      "skip"
    );
    expect(decideSessionCommentsFetch(errored, false, NOW + 11_000)).toBe(
      "claim"
    );
  });

  it("a force behind an in-flight fetch QUEUES; a plain call just skips", () => {
    const loading = entry({ state: "loading" });
    expect(decideSessionCommentsFetch(loading, true, NOW)).toBe("queue_force");
    expect(decideSessionCommentsFetch(loading, false, NOW)).toBe("skip");
  });

  it("an idle entry never counts as fresh", () => {
    expect(
      decideSessionCommentsFetch(entry({ state: "idle" }), false, NOW)
    ).toBe("claim");
  });
});

describe("shouldEvictSessionCommentsOnError — visibility revocation evicts", () => {
  it("evicts on ORG2_FORBIDDEN and ORG2_SESSION_NOT_FOUND", () => {
    expect(
      shouldEvictSessionCommentsOnError(
        new Org2CloudCommentError("ORG2_FORBIDDEN: restricted", 403)
      )
    ).toBe(true);
    expect(
      shouldEvictSessionCommentsOnError(
        new Org2CloudCommentError("ORG2_SESSION_NOT_FOUND: gone", 404)
      )
    ).toBe(true);
  });

  it("keeps the cache on transient/unknown failures", () => {
    expect(shouldEvictSessionCommentsOnError(new Error("network down"))).toBe(
      false
    );
    expect(
      shouldEvictSessionCommentsOnError(
        new Org2CloudCommentError("ORG2_AUTH_REQUIRED: token expired", 401)
      )
    ).toBe(false);
    expect(shouldEvictSessionCommentsOnError(undefined)).toBe(false);
  });
});

describe("mergePresentEventIdEntries — per-provider registry union", () => {
  it("null when no provider publishes (presence unknown)", () => {
    expect(mergePresentEventIdEntries(undefined)).toBeNull();
    expect(mergePresentEventIdEntries({})).toBeNull();
  });

  it("returns the single instance's set untouched", () => {
    const only = new Set(["e1", "e2"]);
    expect(mergePresentEventIdEntries({ p1: only })).toBe(only);
  });

  it("unions multiple panes on the same session", () => {
    const merged = mergePresentEventIdEntries({
      p1: new Set(["e1", "e2"]),
      p2: new Set(["e2", "e3"]),
    });
    expect(merged && [...merged].sort()).toEqual(["e1", "e2", "e3"]);
  });
});
