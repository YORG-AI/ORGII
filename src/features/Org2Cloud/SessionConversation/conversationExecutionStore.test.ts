import { describe, expect, it } from "vitest";

import {
  MAX_CONVERSATION_CONTINUATION_EPISODES,
  __CONVERSATION_EXECUTION_STORE_INTERNALS,
  advanceStoredContinuationReadThrough,
  advanceStoredOwnerPlaneCursor,
  collectStoredRunnerSessionIds,
  conversationExecutionKey,
  forgetStoredRunner,
  loadStoredContinuation,
  loadStoredContinuationLineage,
  loadStoredOwnerPlaneCursor,
  loadStoredRunnerRegistryEntry,
  markStoredContinuationEstablished,
  markStoredRunnerTerminal,
  prepareStoredContinuation,
  registerStoredRunner,
  retireStoredContinuation,
  saveStoredContinuation,
} from "./conversationExecutionStore";

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("conversation execution store", () => {
  it("uses tuple keys without colon collisions", () => {
    expect(conversationExecutionKey("a:b", "c")).not.toBe(
      conversationExecutionKey("a", "b:c")
    );
  });

  it("preserves runner, continuation, and owner cursor in one entry", () => {
    const backing = fakeStorage();
    const key = conversationExecutionKey("scope", "root");
    prepareStoredContinuation(
      "scope",
      "root",
      {
        continuationSessionId: "runner-1",
        readThroughPlaneSeq: 12,
        established: true,
        agentDefinitionId: "agent-a",
        cliAgentType: "codex",
      },
      "2026-08-25T00:00:00Z",
      backing
    );
    advanceStoredOwnerPlaneCursor("scope", "root", 9, backing);
    markStoredRunnerTerminal(key, "runner-1", backing);

    expect(loadStoredRunnerRegistryEntry(key, backing)).toMatchObject({
      runnerSessionIds: ["runner-1"],
      terminalRunnerSessionIds: ["runner-1"],
    });
    expect(loadStoredContinuation("scope", "root", backing)).toMatchObject({
      continuationSessionId: "runner-1",
      readThroughPlaneSeq: 12,
      cliAgentType: "codex",
    });
    expect(
      loadStoredOwnerPlaneCursor("scope", "root", backing)?.readThroughPlaneSeq
    ).toBe(9);
    expect(backing.length).toBe(1);
  });

  it("advances both plane cursors monotonically", () => {
    const backing = fakeStorage();
    saveStoredContinuation(
      "scope",
      "root",
      {
        continuationSessionId: "runner-1",
        readThroughPlaneSeq: 12,
        established: true,
        agentDefinitionId: "agent-a",
      },
      backing
    );
    advanceStoredContinuationReadThrough("scope", "root", 40, backing);
    advanceStoredContinuationReadThrough("scope", "root", 30, backing);
    advanceStoredOwnerPlaneCursor("scope", "root", 18, backing);
    advanceStoredOwnerPlaneCursor("scope", "root", 11, backing);

    expect(
      loadStoredContinuation("scope", "root", backing)?.readThroughPlaneSeq
    ).toBe(40);
    expect(
      loadStoredOwnerPlaneCursor("scope", "root", backing)?.readThroughPlaneSeq
    ).toBe(18);
    expect(() =>
      advanceStoredOwnerPlaneCursor("scope", "root", -1, backing)
    ).toThrow("invalid conversation plane seq");
  });

  it("upgrades a legacy continuation into one authoritative episode", () => {
    const backing = fakeStorage();
    const key = conversationExecutionKey("scope", "root");
    const legacyStorageKey =
      __CONVERSATION_EXECUTION_STORE_INTERNALS.legacyEntryStorageKey(key);
    const legacyRaw = JSON.stringify({
      version: 1,
      continuation: {
        continuationSessionId: "legacy-runner",
        readThroughPlaneSeq: 7,
        established: true,
        agentDefinitionId: "agent-a",
        updatedAt: "2026-08-24T00:00:00Z",
      },
    });
    backing.setItem(legacyStorageKey, legacyRaw);

    expect(loadStoredContinuation("scope", "root", backing)).toMatchObject({
      episodeId: "conversation-episode:legacy-runner",
      continuationSessionId: "legacy-runner",
      readThroughPlaneSeq: 7,
    });
    expect(
      loadStoredContinuationLineage("scope", "root", backing)
    ).toMatchObject({
      activeEpisodeId: "conversation-episode:legacy-runner",
      episodes: [
        {
          episodeId: "conversation-episode:legacy-runner",
          state: "active",
        },
      ],
    });

    advanceStoredContinuationReadThrough("scope", "root", 8, backing);
    const currentStorageKey =
      __CONVERSATION_EXECUTION_STORE_INTERNALS.entryStorageKey(key);
    const upgraded = JSON.parse(
      backing.getItem(currentStorageKey) ?? "null"
    ) as {
      version?: number;
      continuationLineage?: { activeEpisodeId?: string };
    };
    expect(upgraded.version).toBe(2);
    expect(upgraded.continuationLineage?.activeEpisodeId).toBe(
      "conversation-episode:legacy-runner"
    );
    expect(backing.getItem(legacyStorageKey)).toBe(legacyRaw);
    expect(loadStoredContinuation("scope", "root", backing)).toMatchObject({
      readThroughPlaneSeq: 8,
    });

    // Simulate an old window writing its v1 projection after v2 migration.
    backing.setItem(
      legacyStorageKey,
      legacyRaw.replace('"readThroughPlaneSeq":7', '"readThroughPlaneSeq":99')
    );
    expect(loadStoredContinuation("scope", "root", backing)).toMatchObject({
      readThroughPlaneSeq: 8,
    });
  });

  it("fails closed when a correctness write is not durable", () => {
    const values = new Map<string, string>();
    const backing: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => values.delete(key),
      setItem: () => undefined,
    };

    expect(() =>
      prepareStoredContinuation(
        "scope",
        "root",
        {
          continuationSessionId: "runner-1",
          readThroughPlaneSeq: 0,
          established: false,
          bootstrapTurnIntentId: "intent-1",
          agentDefinitionId: "agent-a",
        },
        "2026-08-25T00:00:00Z",
        backing
      )
    ).toThrow("conversation execution state did not persist");
  });

  it("fails closed when correctness storage is unavailable", () => {
    expect(() =>
      saveStoredContinuation(
        "scope",
        "root",
        {
          continuationSessionId: "runner-1",
          readThroughPlaneSeq: 0,
          established: true,
          agentDefinitionId: "agent-a",
        },
        null
      )
    ).toThrow("conversation execution storage unavailable");
  });

  it("keeps the requested active episode when bounding malformed lineage", () => {
    const backing = fakeStorage();
    const key = conversationExecutionKey("scope", "root");
    const episodes = Array.from({ length: 20 }, (_, index) => ({
      episodeId: `episode-${index}`,
      continuationSessionId: `runner-${index}`,
      readThroughPlaneSeq: index,
      established: true,
      agentDefinitionId: "agent-a",
      updatedAt: `2026-08-25T00:00:${String(index).padStart(2, "0")}Z`,
      state: index === 0 ? "active" : "retired",
      createdAt: `2026-08-25T00:00:${String(index).padStart(2, "0")}Z`,
    }));
    backing.setItem(
      __CONVERSATION_EXECUTION_STORE_INTERNALS.entryStorageKey(key),
      JSON.stringify({
        version: 2,
        continuationLineage: {
          activeEpisodeId: "episode-0",
          episodes,
          updatedAt: "2026-08-25T00:01:00Z",
        },
      })
    );

    const lineage = loadStoredContinuationLineage("scope", "root", backing);
    expect(lineage?.activeEpisodeId).toBe("episode-0");
    expect(lineage?.episodes).toHaveLength(
      MAX_CONVERSATION_CONTINUATION_EPISODES
    );
    expect(lineage?.episodes[0].episodeId).toBe("episode-0");
  });

  it("keeps a bounded, explainable episode lineage", () => {
    const backing = fakeStorage();
    for (
      let index = 0;
      index < MAX_CONVERSATION_CONTINUATION_EPISODES + 4;
      index += 1
    ) {
      saveStoredContinuation(
        "scope",
        "root",
        {
          continuationSessionId: `runner-${index}`,
          readThroughPlaneSeq: index,
          established: true,
          agentDefinitionId: "agent-a",
        },
        backing
      );
    }

    const lineage = loadStoredContinuationLineage("scope", "root", backing);
    expect(lineage?.episodes).toHaveLength(
      MAX_CONVERSATION_CONTINUATION_EPISODES
    );
    expect(lineage?.episodes[0].continuationSessionId).toBe("runner-4");
    expect(lineage?.episodes.at(-1)).toMatchObject({
      continuationSessionId: `runner-${MAX_CONVERSATION_CONTINUATION_EPISODES + 3}`,
      state: "active",
    });
    expect(
      lineage?.episodes.filter((episode) => episode.state === "active")
    ).toHaveLength(1);
  });

  it("retires the active episode with a durable reason", () => {
    const backing = fakeStorage();
    saveStoredContinuation(
      "scope",
      "root",
      {
        continuationSessionId: "runner-1",
        readThroughPlaneSeq: 9,
        established: true,
        agentDefinitionId: "agent-a",
      },
      backing
    );

    expect(
      retireStoredContinuation(
        "scope",
        "root",
        "resume_transport_rejected",
        "failed",
        backing
      )
    ).toMatchObject({
      continuationSessionId: "runner-1",
      state: "failed",
      rollReason: "resume_transport_rejected",
    });
    expect(loadStoredContinuation("scope", "root", backing)).toBeNull();
    const lineage = loadStoredContinuationLineage("scope", "root", backing);
    expect(lineage?.activeEpisodeId).toBeUndefined();
    expect(lineage).toMatchObject({
      episodes: [
        {
          continuationSessionId: "runner-1",
          state: "failed",
          rollReason: "resume_transport_rejected",
        },
      ],
    });
  });

  it("establishes only the exact bootstrap runner and intent", () => {
    const backing = fakeStorage();
    saveStoredContinuation(
      "scope",
      "root",
      {
        continuationSessionId: "runner-1",
        readThroughPlaneSeq: 0,
        established: false,
        bootstrapTurnIntentId: "intent-1",
        agentDefinitionId: "agent-a",
      },
      backing
    );

    expect(
      markStoredContinuationEstablished(
        "scope",
        "root",
        "runner-2",
        "intent-1",
        backing
      )
    ).toBe(false);
    expect(
      markStoredContinuationEstablished(
        "scope",
        "root",
        "runner-1",
        "intent-2",
        backing
      )
    ).toBe(false);
    expect(
      markStoredContinuationEstablished(
        "scope",
        "root",
        "runner-1",
        "intent-1",
        backing
      )
    ).toBe(true);
    expect(loadStoredContinuation("scope", "root", backing)).toMatchObject({
      established: true,
      readThroughPlaneSeq: 0,
    });
    expect(
      loadStoredContinuation("scope", "root", backing)?.bootstrapTurnIntentId
    ).toBeUndefined();
  });

  it("persists and sanitizes runner lifecycle per conversation", () => {
    const backing = fakeStorage();
    const key = conversationExecutionKey("scope", "root");

    registerStoredRunner(key, "runner-1", "2026-08-25T00:00:00Z", backing);
    registerStoredRunner(key, "runner-1", "2026-08-25T00:00:01Z", backing);
    registerStoredRunner(key, "runner-2", "2026-08-25T00:00:02Z", backing);
    markStoredRunnerTerminal(key, "runner-1", backing);

    expect(loadStoredRunnerRegistryEntry(key, backing)).toMatchObject({
      runnerSessionIds: ["runner-1", "runner-2"],
      terminalRunnerSessionIds: ["runner-1"],
    });
    expect(collectStoredRunnerSessionIds(backing)).toEqual(
      new Set(["runner-1", "runner-2"])
    );
  });

  it("keeps legacy one-shot runner ids hidden after upgrade", () => {
    const backing = fakeStorage();
    backing.setItem(
      __CONVERSATION_EXECUTION_STORE_INTERNALS.LEGACY_RUNNERS_KEY,
      JSON.stringify({
        "org:root": {
          runnerSessionIds: ["legacy-runner", "legacy-runner", ""],
          updatedAt: "2026-08-24T00:00:00Z",
        },
        broken: { runnerSessionIds: "not-an-array" },
      })
    );

    expect(collectStoredRunnerSessionIds(backing)).toEqual(
      new Set(["legacy-runner"])
    );
  });

  it("isolates malformed entries and recovers on the next valid write", () => {
    const backing = fakeStorage();
    const key = conversationExecutionKey("scope", "root");
    backing.setItem(
      __CONVERSATION_EXECUTION_STORE_INTERNALS.entryStorageKey(key),
      "{not-json"
    );

    expect(loadStoredRunnerRegistryEntry(key, backing)).toBeNull();
    registerStoredRunner(key, "runner-1", "2026-08-25T00:00:00Z", backing);
    expect(
      loadStoredRunnerRegistryEntry(key, backing)?.runnerSessionIds
    ).toEqual(["runner-1"]);
  });

  it("does not lose an unrelated window write during a nested write", () => {
    const values = new Map<string, string>();
    const first = conversationExecutionKey("scope", "first");
    const second = conversationExecutionKey("scope", "second");
    const firstStorageKey =
      __CONVERSATION_EXECUTION_STORE_INTERNALS.entryStorageKey(first);
    let nested = false;
    const backing: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => {
        values.delete(key);
      },
      setItem: (key, value) => {
        if (key === firstStorageKey && !nested) {
          nested = true;
          registerStoredRunner(
            second,
            "runner-second",
            "2026-08-25T00:00:01Z",
            backing
          );
        }
        values.set(key, value);
      },
    };

    registerStoredRunner(
      first,
      "runner-first",
      "2026-08-25T00:00:00Z",
      backing
    );

    expect(
      loadStoredRunnerRegistryEntry(first, backing)?.runnerSessionIds
    ).toEqual(["runner-first"]);
    expect(
      loadStoredRunnerRegistryEntry(second, backing)?.runnerSessionIds
    ).toEqual(["runner-second"]);
  });

  it("forgets current and legacy runners without touching siblings", () => {
    const backing = fakeStorage();
    const first = conversationExecutionKey("scope", "first");
    const second = conversationExecutionKey("scope", "second");
    registerStoredRunner(first, "remove-me", "2026-08-25T00:00:00Z", backing);
    registerStoredRunner(
      first,
      "keep-current",
      "2026-08-25T00:00:01Z",
      backing
    );
    registerStoredRunner(second, "keep-other", "2026-08-25T00:00:02Z", backing);
    saveStoredContinuation(
      "scope",
      "first",
      {
        continuationSessionId: "remove-me",
        readThroughPlaneSeq: 4,
        established: true,
        agentDefinitionId: "agent-a",
      },
      backing
    );
    advanceStoredOwnerPlaneCursor("scope", "first", 3, backing);
    backing.setItem(
      __CONVERSATION_EXECUTION_STORE_INTERNALS.LEGACY_RUNNERS_KEY,
      JSON.stringify({
        "org:root": {
          runnerSessionIds: ["remove-me", "keep-legacy"],
          terminalRunnerSessionIds: ["remove-me"],
          updatedAt: "2026-08-24T00:00:00Z",
        },
      })
    );

    forgetStoredRunner("remove-me", backing);

    expect(collectStoredRunnerSessionIds(backing)).toEqual(
      new Set(["keep-current", "keep-other", "keep-legacy"])
    );
    expect(loadStoredRunnerRegistryEntry(first, backing)).toMatchObject({
      runnerSessionIds: ["keep-current"],
      terminalRunnerSessionIds: [],
    });
    expect(loadStoredContinuation("scope", "first", backing)).toBeNull();
    expect(
      loadStoredOwnerPlaneCursor("scope", "first", backing)?.readThroughPlaneSeq
    ).toBe(3);
  });
});
