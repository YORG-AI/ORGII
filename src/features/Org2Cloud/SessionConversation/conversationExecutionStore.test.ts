import { describe, expect, it } from "vitest";

import {
  __CONVERSATION_EXECUTION_STORE_INTERNALS,
  cloudConversationExecutorScopeKey,
  collectStoredRunnerSessionIds,
  conversationExecutionKey,
  forgetStoredRunner,
  loadStoredRunnerRegistryEntry,
  markStoredRunnerTerminal,
  registerStoredRunner,
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
  it("keys execution by account, organization, and root session", () => {
    const scope = cloudConversationExecutorScopeKey(
      "https://cloud.example|user-b",
      "cloud-org"
    );

    expect(scope).toBe(
      JSON.stringify([
        "cloud-conversation-executor",
        "https://cloud.example|user-b",
        "cloud-org",
      ])
    );
    expect(conversationExecutionKey(scope, "root-a")).not.toBe(
      conversationExecutionKey(scope, "root-b")
    );
    expect(
      conversationExecutionKey(
        cloudConversationExecutorScopeKey(
          "https://cloud.example|user-c",
          "cloud-org"
        ),
        "root-a"
      )
    ).not.toBe(conversationExecutionKey(scope, "root-a"));
  });

  it("uses tuple keys without colon collisions", () => {
    expect(conversationExecutionKey("a:b", "c")).not.toBe(
      conversationExecutionKey("a", "b:c")
    );
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
  });
});
