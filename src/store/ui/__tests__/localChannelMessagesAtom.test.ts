import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import {
  LOCAL_CHANNEL_MESSAGES_STORAGE_KEY,
  LOCAL_CHANNEL_MESSAGE_MAX_LENGTH,
  LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL,
  LOCAL_CHANNEL_MESSAGE_MAX_TOTAL,
  LOCAL_CHANNEL_MESSAGE_STORAGE_BUDGET_BYTES,
  type LocalChannelMessage,
  deleteLocalChannelMessage,
  deleteLocalChannelMessageAtom,
  editLocalChannelMessage,
  localChannelMessagesAtom,
  localChannelMessagesForChannelAtomFamily,
  postLocalChannelMessage,
  postLocalChannelMessageAtom,
  purgeLocalChannelMessages,
  purgeOrphanedLocalChannelMessages,
  selectLocalChannelMessages,
} from "../localChannelMessagesAtom";
import {
  LOCAL_CHANNELS_STORAGE_KEY,
  type LocalChannel,
  deleteLocalChannelAtom,
  localChannelsAtom,
  reconcileLocalChannelMessagesAtom,
} from "../localChannelsAtom";

const NOW = "2026-07-31T00:00:00.000Z";
const LATER = "2026-07-31T01:00:00.000Z";

function makeMessage(
  overrides: Partial<LocalChannelMessage> = {}
): LocalChannelMessage {
  return {
    id: "msg-1",
    channelId: "chan-1",
    body: "ship the hotfix-branch",
    createdAt: NOW,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function manyMessages(count: number, channelId = "chan-1") {
  return Array.from({ length: count }, (_, index) =>
    makeMessage({ id: `msg-${index}`, channelId })
  );
}

beforeEach(() => {
  localStorage.removeItem(LOCAL_CHANNEL_MESSAGES_STORAGE_KEY);
  localStorage.removeItem(LOCAL_CHANNELS_STORAGE_KEY);
});

/**
 * `atomWithStorage` re-reads persisted bytes per store in `onMount`, which
 * only fires once the atom is SUBSCRIBED — a bare `store.get` would return
 * the module-init snapshot instead.
 */
function hydratedStore(): ReturnType<typeof createStore> {
  const store = createStore();
  store.sub(localChannelMessagesAtom, () => undefined);
  store.sub(localChannelsAtom, () => undefined);
  return store;
}

describe("postLocalChannelMessage", () => {
  it("trims the body and stamps post metadata", () => {
    const result = postLocalChannelMessage([], {
      channelId: "chan-1",
      body: "   review the code-review queue   ",
      id: "msg-new",
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      messages: [
        {
          id: "msg-new",
          channelId: "chan-1",
          body: "review the code-review queue",
          createdAt: NOW,
          editedAt: null,
          deletedAt: null,
        },
      ],
      message: expect.objectContaining({ id: "msg-new" }),
    });
  });

  it("rejects a whitespace-only body as empty", () => {
    expect(
      postLocalChannelMessage([], { channelId: "chan-1", body: "   \n  " })
    ).toEqual({ ok: false, error: "empty" });
  });

  it("rejects a body past the length ceiling", () => {
    expect(
      postLocalChannelMessage([], {
        channelId: "chan-1",
        body: "x".repeat(LOCAL_CHANNEL_MESSAGE_MAX_LENGTH + 1),
      })
    ).toEqual({ ok: false, error: "tooLong" });
  });

  it("accepts a body exactly at the ceiling", () => {
    const result = postLocalChannelMessage([], {
      channelId: "chan-1",
      body: "x".repeat(LOCAL_CHANNEL_MESSAGE_MAX_LENGTH),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses to post past the per-channel cap", () => {
    expect(
      postLocalChannelMessage(
        manyMessages(LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL),
        { channelId: "chan-1", body: "release-notes" }
      )
    ).toEqual({ ok: false, error: "quota" });
  });

  it("counts the cap per channel, not globally", () => {
    const result = postLocalChannelMessage(
      manyMessages(LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL, "chan-1"),
      { channelId: "chan-2", body: "release-notes" }
    );
    expect(result.ok).toBe(true);
  });

  it("does not count tombstones toward the cap — deleting frees a slot", () => {
    const full = manyMessages(LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL).map(
      (message, index) =>
        index === 0 ? { ...message, deletedAt: LATER, body: "" } : message
    );
    const result = postLocalChannelMessage(full, {
      channelId: "chan-1",
      body: "release-notes",
    });
    expect(result.ok).toBe(true);
  });

  it("compacts the oldest tombstone when total rows hit the cap", () => {
    const full = manyMessages(LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL).map(
      (message, index) =>
        index <= 1 ? { ...message, deletedAt: LATER, body: "" } : message
    );
    const result = postLocalChannelMessage(full, {
      channelId: "chan-1",
      body: "release-notes",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Total rows stay at the cap: the oldest tombstone (msg-0) was evicted,
    // the younger tombstone (msg-1) survives.
    expect(result.messages).toHaveLength(LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL);
    const ids = result.messages.map((message) => message.id);
    expect(ids).not.toContain("msg-0");
    expect(ids).toContain("msg-1");
  });

  it("refuses to post when live rows across channels hit the global cap", () => {
    const messages = Array.from(
      { length: LOCAL_CHANNEL_MESSAGE_MAX_TOTAL },
      (_, index) =>
        makeMessage({
          id: `global-${index}`,
          channelId: `chan-${index % 5}`,
        })
    );

    expect(
      postLocalChannelMessage(messages, {
        channelId: "chan-new",
        body: "release-notes",
      })
    ).toEqual({ ok: false, error: "quota" });
  });

  it("refuses a write before the serialized store exceeds its byte budget", () => {
    const largeBody = "界".repeat(LOCAL_CHANNEL_MESSAGE_MAX_LENGTH);
    const messages = Array.from({ length: 350 }, (_, index) =>
      makeMessage({
        id: `large-${index}`,
        channelId: `large-channel-${index}`,
        body: largeBody,
      })
    );
    expect(
      new TextEncoder().encode(JSON.stringify(messages)).byteLength
    ).toBeGreaterThan(LOCAL_CHANNEL_MESSAGE_STORAGE_BUDGET_BYTES);

    expect(
      postLocalChannelMessage(messages, {
        channelId: "chan-new",
        body: "release-notes",
      })
    ).toEqual({ ok: false, error: "quota" });
  });
});

describe("editLocalChannelMessage", () => {
  it("replaces the body and stamps editedAt", () => {
    const result = editLocalChannelMessage([makeMessage()], "msg-1", {
      body: "  cut the release-notes  ",
      now: LATER,
    });
    expect(result).toEqual({
      ok: true,
      messages: [
        expect.objectContaining({
          body: "cut the release-notes",
          editedAt: LATER,
        }),
      ],
      message: expect.objectContaining({ editedAt: LATER }),
    });
  });

  it("rejects an empty edit instead of blanking the message", () => {
    expect(
      editLocalChannelMessage([makeMessage()], "msg-1", { body: "  " })
    ).toEqual({ ok: false, error: "empty" });
  });

  it("refuses to edit a tombstone", () => {
    const tombstone = makeMessage({ body: "", deletedAt: LATER });
    expect(
      editLocalChannelMessage([tombstone], "msg-1", { body: "back again" })
    ).toEqual({ ok: false, error: "invalid" });
  });

  it("reports an unknown id as invalid", () => {
    expect(
      editLocalChannelMessage([makeMessage()], "missing", { body: "hi" })
    ).toEqual({ ok: false, error: "invalid" });
  });
});

describe("deleteLocalChannelMessage", () => {
  it("tombstones the row instead of removing it", () => {
    const result = deleteLocalChannelMessage([makeMessage()], "msg-1", LATER);
    expect(result).toEqual({
      ok: true,
      messages: [
        expect.objectContaining({ id: "msg-1", body: "", deletedAt: LATER }),
      ],
      message: expect.objectContaining({ deletedAt: LATER }),
    });
  });

  it("is idempotent — a second delete keeps the first stamp", () => {
    const tombstone = makeMessage({ body: "", deletedAt: NOW });
    const result = deleteLocalChannelMessage([tombstone], "msg-1", LATER);
    expect(result).toEqual({
      ok: true,
      messages: [tombstone],
      message: tombstone,
    });
  });
});

describe("selectLocalChannelMessages", () => {
  it("returns one channel's rows ascending by createdAt", () => {
    const messages = [
      makeMessage({ id: "b", createdAt: LATER }),
      makeMessage({ id: "other", channelId: "chan-2" }),
      makeMessage({ id: "a", createdAt: NOW }),
    ];
    expect(
      selectLocalChannelMessages(messages, "chan-1").map((m) => m.id)
    ).toEqual(["a", "b"]);
  });

  it("blanks a tombstone's body at read time", () => {
    const stale = makeMessage({ body: "leaked", deletedAt: LATER });
    expect(selectLocalChannelMessages([stale], "chan-1")).toEqual([
      expect.objectContaining({ body: "", deletedAt: LATER }),
    ]);
  });
});

describe("purgeLocalChannelMessages", () => {
  it("drops only the target channel's rows", () => {
    const messages = [
      makeMessage({ id: "a" }),
      makeMessage({ id: "b", channelId: "chan-2" }),
    ];
    expect(purgeLocalChannelMessages(messages, "chan-1")).toEqual([
      expect.objectContaining({ id: "b" }),
    ]);
  });

  it("drops every row whose owning channel no longer exists", () => {
    const messages = [
      makeMessage({ id: "keep", channelId: "chan-1" }),
      makeMessage({ id: "orphan-a", channelId: "gone-1" }),
      makeMessage({ id: "orphan-b", channelId: "gone-2" }),
    ];

    expect(
      purgeOrphanedLocalChannelMessages(messages, new Set(["chan-1"]))
    ).toEqual([expect.objectContaining({ id: "keep" })]);
  });
});

describe("persistence", () => {
  it("drops a malformed row and keeps the rest", () => {
    localStorage.setItem(
      LOCAL_CHANNEL_MESSAGES_STORAGE_KEY,
      JSON.stringify([{ id: 42 }, makeMessage()])
    );
    const store = hydratedStore();
    expect(store.get(localChannelMessagesAtom)).toEqual([makeMessage()]);
  });

  it("recovers from garbage bytes with an empty list", () => {
    localStorage.setItem(LOCAL_CHANNEL_MESSAGES_STORAGE_KEY, "{not json");
    const store = hydratedStore();
    expect(store.get(localChannelMessagesAtom)).toEqual([]);
  });
});

describe("write atoms", () => {
  it("posts through the atom and exposes the row on the channel selector", () => {
    const store = hydratedStore();
    const result = store.set(postLocalChannelMessageAtom, {
      channelId: "chan-1",
      body: "rebase onto hotfix-branch",
      id: "msg-new",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(
      store.get(localChannelMessagesForChannelAtomFamily("chan-1"))
    ).toEqual([expect.objectContaining({ id: "msg-new" })]);
  });

  it("keeps the tombstone visible to the channel selector after delete", () => {
    const store = hydratedStore();
    store.set(localChannelMessagesAtom, [makeMessage()]);
    store.set(deleteLocalChannelMessageAtom, "msg-1");
    const rows = store.get(localChannelMessagesForChannelAtomFamily("chan-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("");
    expect(rows[0].deletedAt).not.toBeNull();
  });
});

describe("deleting a local channel purges its messages", () => {
  const channel: LocalChannel = {
    id: "chan-1",
    name: "code-review",
    topic: undefined,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
  const otherChannel: LocalChannel = {
    ...channel,
    id: "chan-2",
    name: "release-notes",
  };

  it("removes the deleted channel's rows and leaves other channels alone", () => {
    const store = hydratedStore();
    store.set(localChannelsAtom, [channel, otherChannel]);
    store.set(localChannelMessagesAtom, [
      makeMessage({ id: "a", channelId: "chan-1" }),
      makeMessage({ id: "tombstone", channelId: "chan-1", deletedAt: LATER }),
      makeMessage({ id: "keep", channelId: "chan-2" }),
    ]);

    const result = store.set(deleteLocalChannelAtom, "chan-1");

    expect(result.ok).toBe(true);
    expect(store.get(localChannelsAtom)).toEqual([otherChannel]);
    expect(store.get(localChannelMessagesAtom)).toEqual([
      expect.objectContaining({ id: "keep" }),
    ]);
  });

  it("leaves the message plane untouched when the delete is refused", () => {
    const store = hydratedStore();
    store.set(localChannelsAtom, [channel]);
    store.set(localChannelMessagesAtom, [makeMessage()]);

    const result = store.set(deleteLocalChannelAtom, "missing");

    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(store.get(localChannelMessagesAtom)).toHaveLength(1);
  });

  it("sweeps boot-time orphans and evicts their selector-family entries", () => {
    const store = hydratedStore();
    store.set(localChannelsAtom, [channel]);
    store.set(localChannelMessagesAtom, [
      makeMessage({ id: "keep", channelId: "chan-1" }),
      makeMessage({ id: "orphan", channelId: "gone" }),
    ]);
    const orphanSelector = localChannelMessagesForChannelAtomFamily("gone");

    const result = store.set(reconcileLocalChannelMessagesAtom);

    expect(result).toEqual({
      removed: 1,
      orphanedChannelIds: ["gone"],
    });
    expect(store.get(localChannelMessagesAtom)).toEqual([
      expect.objectContaining({ id: "keep" }),
    ]);
    expect(localChannelMessagesForChannelAtomFamily("gone")).not.toBe(
      orphanSelector
    );
  });
});
