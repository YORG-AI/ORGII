import { describe, expect, it } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  type CloudOrgRemoteSessionsEntry,
  type CloudRemoteSessionsInvalidation,
  MAX_REMOTE_SESSIONS_VERSION_KEYS,
  MAX_REMOTE_SESSION_CACHE_ENTRIES,
  beginRemoteSessionsFetch,
  bumpRemoteSessionsInvalidation,
  mergeRemoteSessionDelta,
  rememberRemoteSessionsFetchedVersion,
  remoteSessionsEntryForIdentity,
  retainUnchangedRemoteSessionRows,
  writeRemoteSessionsEntry,
} from "./org2CloudRemoteSessionsAtom";

function row(
  id: string,
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id,
    orgId: "org-1",
    ownerMemberId: "member-1",
    ownerUserId: "user-1",
    ownerDisplayName: "Owner",
    ownerIdentityKind: "human",
    sourceSessionId: id,
    title: id,
    eventsEpoch: undefined,
    eventsFrozenSeq: undefined,
    eventsCount: undefined,
    eventsTailHash: undefined,
    ...overrides,
  };
}

function readyEntry(identityKey: string): CloudOrgRemoteSessionsEntry {
  return {
    identityKey,
    rows: [],
    state: "ready",
    fetchedAt: 123,
  };
}

describe("cloud remote session identity isolation", () => {
  it("hides an app-lifetime snapshot after an account switch", () => {
    const entry = readyEntry("https://cloud.example.com|user-1");
    expect(
      remoteSessionsEntryForIdentity(entry, "https://cloud.example.com|user-2")
    ).toBeUndefined();
    expect(
      remoteSessionsEntryForIdentity(entry, "https://cloud.example.com|user-1")
    ).toBe(entry);
  });

  it("starts a different identity from an empty loading snapshot", () => {
    expect(
      beginRemoteSessionsFetch(
        readyEntry("https://cloud.example.com|user-1"),
        "https://cloud.example.com|user-2"
      )
    ).toEqual({
      identityKey: "https://cloud.example.com|user-2",
      rows: [],
      state: "loading",
      fetchedAt: 0,
    });
  });

  it("bounds visited-org version bookkeeping with LRU eviction", () => {
    const versions = new Map<string, number>();
    for (let index = 0; index <= MAX_REMOTE_SESSIONS_VERSION_KEYS; index += 1) {
      rememberRemoteSessionsFetchedVersion(versions, `org-${index}`, index);
    }
    expect(versions.size).toBe(MAX_REMOTE_SESSIONS_VERSION_KEYS);
    expect(versions.has("org-0")).toBe(false);
    expect(versions.get(`org-${MAX_REMOTE_SESSIONS_VERSION_KEYS}`)).toBe(
      MAX_REMOTE_SESSIONS_VERSION_KEYS
    );
  });

  it("bounds cached org session listings with LRU eviction", () => {
    let entries: Record<string, CloudOrgRemoteSessionsEntry> = {};
    for (let index = 0; index <= MAX_REMOTE_SESSION_CACHE_ENTRIES; index += 1) {
      entries = writeRemoteSessionsEntry(
        entries,
        `org-${index}`,
        readyEntry("https://cloud.example.com|user-1")
      );
    }
    expect(Object.keys(entries)).toHaveLength(MAX_REMOTE_SESSION_CACHE_ENTRIES);
    expect(entries["org-0"]).toBeUndefined();
  });

  it("merges cursor deltas and removes soft tombstones", () => {
    expect(
      mergeRemoteSessionDelta(
        [
          row("keep", { title: "old", lastActivityAt: "2026-07-01" }),
          row("remove"),
        ],
        [
          row("keep", { title: "new", lastActivityAt: "2026-07-03" }),
          row("remove", { deletedAt: "2026-07-04" }),
          row("add", { lastActivityAt: "2026-07-02" }),
        ]
      ).map(({ id, title }) => ({ id, title }))
    ).toEqual([
      { id: "keep", title: "new" },
      { id: "add", title: "add" },
    ]);
  });

  it("keeps a ready snapshot visible while it revalidates", () => {
    const entry = {
      ...readyEntry("https://cloud.example.com|user-1"),
      rows: [row("visible")],
    };

    expect(
      beginRemoteSessionsFetch(entry, "https://cloud.example.com|user-1")
    ).toBe(entry);
  });

  it("marks reconnect recovery as a full refresh without touching rows", () => {
    const first = bumpRemoteSessionsInvalidation({}, "org-1");
    expect(first["org-1"]).toEqual({
      version: 1,
      fullRefreshVersion: 0,
    });

    expect(
      bumpRemoteSessionsInvalidation(first, "org-1", { full: true })["org-1"]
    ).toEqual({
      version: 2,
      fullRefreshVersion: 1,
    });
  });

  it("bounds invalidation signals and refreshes recency on write", () => {
    let signals: Record<string, CloudRemoteSessionsInvalidation> = {};
    for (let index = 0; index <= MAX_REMOTE_SESSIONS_VERSION_KEYS; index += 1) {
      signals = bumpRemoteSessionsInvalidation(signals, `org-${index}`);
    }
    expect(Object.keys(signals)).toHaveLength(MAX_REMOTE_SESSIONS_VERSION_KEYS);
    expect(signals["org-0"]).toBeUndefined();

    signals = bumpRemoteSessionsInvalidation(signals, "org-1");
    signals = bumpRemoteSessionsInvalidation(signals, "org-new");
    expect(signals["org-1"]?.version).toBe(2);
    expect(signals["org-2"]).toBeUndefined();
  });

  it("retains row identity when a refresh has no semantic changes", () => {
    const previous = [
      row("same", {
        origin: { kind: "external_history", source: "cursor_ide" },
      }),
    ];
    const unchanged = previous.map((item) => ({
      ...item,
      origin: item.origin ? { ...item.origin } : undefined,
    }));
    const changed = unchanged.map((item) => ({ ...item, title: "changed" }));

    expect(retainUnchangedRemoteSessionRows(previous, unchanged)).toBe(
      previous
    );
    expect(retainUnchangedRemoteSessionRows(previous, changed)).toBe(changed);
  });
});
