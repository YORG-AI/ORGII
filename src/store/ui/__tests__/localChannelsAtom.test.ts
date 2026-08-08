import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import {
  LOCAL_CHANNELS_STORAGE_KEY,
  LOCAL_CHANNEL_MAX_ACTIVE,
  LOCAL_CHANNEL_MAX_STORED,
  type LocalChannel,
  activeLocalChannelsAtom,
  archiveLocalChannel,
  archiveLocalChannelAtom,
  archivedLocalChannelsAtom,
  createLocalChannel,
  createLocalChannelAtom,
  deleteLocalChannel,
  deleteLocalChannelAtom,
  localChannelsAtom,
  unarchiveLocalChannel,
  updateLocalChannel,
} from "../localChannelsAtom";

const NOW = "2026-07-31T00:00:00.000Z";
const LATER = "2026-07-31T01:00:00.000Z";

function makeChannel(overrides: Partial<LocalChannel> = {}): LocalChannel {
  return {
    id: "ch-1",
    name: "general",
    topic: undefined,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function manyActiveChannels(count: number): LocalChannel[] {
  return Array.from({ length: count }, (_, index) =>
    makeChannel({ id: `ch-${index}`, name: `channel-${index}` })
  );
}

beforeEach(() => {
  localStorage.removeItem(LOCAL_CHANNELS_STORAGE_KEY);
});

/**
 * `atomWithStorage` re-reads persisted bytes per store in `onMount`, which
 * only fires once the atom is SUBSCRIBED (the app mounts it via hooks) — a
 * bare `store.get` would return the module-init snapshot instead.
 */
function hydratedStore(): ReturnType<typeof createStore> {
  const store = createStore();
  store.sub(localChannelsAtom, () => undefined);
  return store;
}

describe("createLocalChannel", () => {
  it("normalizes Slack-style names and stamps create metadata", () => {
    const result = createLocalChannel([], {
      name: "  #Code Review  ",
      topic: "  release checklist  ",
      id: "ch-new",
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      channels: [
        {
          id: "ch-new",
          name: "code-review",
          topic: "release checklist",
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
        },
      ],
      channel: expect.objectContaining({ name: "code-review" }),
    });
  });

  it("defaults the id to a random UUID and drops an empty topic", () => {
    const result = createLocalChannel([], { name: "general", topic: "   " });
    if (!result.ok) throw new Error("expected ok");
    expect(result.channel.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.channel.topic).toBeUndefined();
  });

  it("rejects names that normalize to empty or exceed the topic cap", () => {
    expect(createLocalChannel([], { name: "  ##  " })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(
      createLocalChannel([], { name: "ok", topic: "x".repeat(251) })
    ).toEqual({ ok: false, error: "invalid" });
    // Exactly at the cap is fine.
    expect(
      createLocalChannel([], { name: "ok", topic: "x".repeat(250) }).ok
    ).toBe(true);
  });

  it("enforces case-insensitive uniqueness including ARCHIVED names", () => {
    const channels = [
      makeChannel({ id: "a", name: "general" }),
      makeChannel({ id: "b", name: "old-plans", archivedAt: NOW }),
    ];
    expect(createLocalChannel(channels, { name: "GENERAL" })).toEqual({
      ok: false,
      error: "nameTaken",
    });
    // Archived names stay reserved (cloud 0014 semantics).
    expect(createLocalChannel(channels, { name: "Old Plans" })).toEqual({
      ok: false,
      error: "nameTaken",
    });
  });

  it("enforces the active quota; archived channels do not count", () => {
    const full = manyActiveChannels(LOCAL_CHANNEL_MAX_ACTIVE);
    expect(createLocalChannel(full, { name: "one-more" })).toEqual({
      ok: false,
      error: "quota",
    });
    const withArchived = [
      ...manyActiveChannels(LOCAL_CHANNEL_MAX_ACTIVE - 1),
      makeChannel({ id: "arch", name: "archived-one", archivedAt: NOW }),
    ];
    expect(createLocalChannel(withArchived, { name: "one-more" }).ok).toBe(
      true
    );
  });

  it("bounds active and archived rows retained on the device", () => {
    const full = Array.from({ length: LOCAL_CHANNEL_MAX_STORED }, (_, index) =>
      makeChannel({
        id: `arch-${index}`,
        name: `archived-${index}`,
        archivedAt: NOW,
      })
    );

    expect(createLocalChannel(full, { name: "one-more" })).toEqual({
      ok: false,
      error: "quota",
    });
  });
});

describe("updateLocalChannel", () => {
  const channels = [
    makeChannel({ id: "a", name: "general", topic: "hello" }),
    makeChannel({ id: "b", name: "reserved", archivedAt: NOW }),
  ];

  it("renames + retopics with normalization and bumps updatedAt", () => {
    const result = updateLocalChannel(channels, "a", {
      name: "#New Name",
      topic: " fresh ",
      now: LATER,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.channel).toEqual(
      expect.objectContaining({
        name: "new-name",
        topic: "fresh",
        updatedAt: LATER,
        createdAt: NOW,
      })
    );
  });

  it("keeps omitted fields, clears the topic on empty string", () => {
    const kept = updateLocalChannel(channels, "a", { now: LATER });
    if (!kept.ok) throw new Error("expected ok");
    expect(kept.channel.name).toBe("general");
    expect(kept.channel.topic).toBe("hello");

    const cleared = updateLocalChannel(channels, "a", { topic: "" });
    if (!cleared.ok) throw new Error("expected ok");
    expect(cleared.channel.topic).toBeUndefined();
  });

  it("treats archived names as taken but allows renaming to itself", () => {
    expect(updateLocalChannel(channels, "a", { name: "Reserved" })).toEqual({
      ok: false,
      error: "nameTaken",
    });
    expect(updateLocalChannel(channels, "a", { name: "GENERAL" }).ok).toBe(
      true
    );
  });

  it("rejects unknown ids and invalid names", () => {
    expect(updateLocalChannel(channels, "missing", { name: "x" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(updateLocalChannel(channels, "a", { name: "##" })).toEqual({
      ok: false,
      error: "invalid",
    });
  });
});

describe("archive / unarchive / delete", () => {
  it("archives softly (row kept) and unarchives back", () => {
    const channels = [makeChannel({ id: "a", name: "general" })];
    const archived = archiveLocalChannel(channels, "a", LATER);
    if (!archived.ok) throw new Error("expected ok");
    expect(archived.channel.archivedAt).toBe(LATER);
    expect(archived.channels).toHaveLength(1);

    const restored = unarchiveLocalChannel(archived.channels, "a", LATER);
    if (!restored.ok) throw new Error("expected ok");
    expect(restored.channel.archivedAt).toBeNull();
  });

  it("re-checks the active quota on unarchive", () => {
    const channels = [
      ...manyActiveChannels(LOCAL_CHANNEL_MAX_ACTIVE),
      makeChannel({ id: "arch", name: "archived-one", archivedAt: NOW }),
    ];
    expect(unarchiveLocalChannel(channels, "arch")).toEqual({
      ok: false,
      error: "quota",
    });
  });

  it("is idempotent for an already-archived / already-active target", () => {
    const archived = makeChannel({ id: "a", archivedAt: NOW });
    const again = archiveLocalChannel([archived], "a", LATER);
    if (!again.ok) throw new Error("expected ok");
    expect(again.channel.archivedAt).toBe(NOW);

    const active = makeChannel({ id: "b" });
    const restored = unarchiveLocalChannel([active], "b");
    if (!restored.ok) throw new Error("expected ok");
    expect(restored.channel.archivedAt).toBeNull();
  });

  it("deletes hard and reports unknown ids", () => {
    const channels = [makeChannel({ id: "a" })];
    const result = deleteLocalChannel(channels, "a");
    if (!result.ok) throw new Error("expected ok");
    expect(result.channels).toEqual([]);
    expect(archiveLocalChannel(channels, "missing")).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(unarchiveLocalChannel(channels, "missing")).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(deleteLocalChannel(channels, "missing")).toEqual({
      ok: false,
      error: "invalid",
    });
  });
});

describe("atoms + persistence", () => {
  it("write atoms commit reducer results and derived atoms sort/split", () => {
    const store = createStore();
    store.set(createLocalChannelAtom, { name: "zulu", id: "z", now: NOW });
    store.set(createLocalChannelAtom, { name: "alpha", id: "a", now: NOW });
    store.set(createLocalChannelAtom, { name: "mid", id: "m", now: NOW });
    store.set(archiveLocalChannelAtom, "m");

    expect(
      store.get(activeLocalChannelsAtom).map((channel) => channel.name)
    ).toEqual(["alpha", "zulu"]);
    expect(
      store.get(archivedLocalChannelsAtom).map((channel) => channel.name)
    ).toEqual(["mid"]);

    // A failed write must not mutate the list.
    const dup = store.set(createLocalChannelAtom, { name: "Alpha" });
    expect(dup).toEqual({ ok: false, error: "nameTaken" });
    expect(store.get(localChannelsAtom)).toHaveLength(3);

    store.set(deleteLocalChannelAtom, "m");
    expect(store.get(archivedLocalChannelsAtom)).toEqual([]);

    // Persistence roundtrip: a fresh store hydrates the same list.
    expect(
      hydratedStore()
        .get(localChannelsAtom)
        .map((channel) => channel.id)
    ).toEqual(["z", "a"]);
  });

  it("recovers from malformed storage instead of crashing hydration", () => {
    localStorage.setItem(LOCAL_CHANNELS_STORAGE_KEY, "{definitely not json");
    expect(hydratedStore().get(localChannelsAtom)).toEqual([]);

    localStorage.setItem(LOCAL_CHANNELS_STORAGE_KEY, '{"not":"an array"}');
    expect(hydratedStore().get(localChannelsAtom)).toEqual([]);
  });

  it("drops only the malformed rows from a partially-corrupt list", () => {
    const valid = makeChannel({ id: "ok", name: "still-here" });
    localStorage.setItem(
      LOCAL_CHANNELS_STORAGE_KEY,
      JSON.stringify([valid, { id: 42, bogus: true }, "junk"])
    );
    expect(hydratedStore().get(localChannelsAtom)).toEqual([valid]);
  });
});
