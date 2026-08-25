import { describe, expect, it } from "vitest";

import { planLegacyConversationRunnerMigration } from "./legacyRunnerMigration";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const executorScope =
  '["org2-conversation-executor",1,"local-device",["member"]]';
const conversationRootKey =
  '["org2-conversation-root",1,"external-history",["claude"],"source-session"]';
const executionKey = JSON.stringify([executorScope, conversationRootKey]);

function entryKey(version: 1 | 2): string {
  return `orgii:conversation-execution-v${version}:${encodeURIComponent(executionKey)}`;
}

describe("legacy conversation runner migration", () => {
  it("imports only exact generic runner membership and terminality", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      entryKey(2),
      JSON.stringify({
        version: 2,
        runners: {
          runnerSessionIds: ["runner-live", "runner-terminal"],
          terminalRunnerSessionIds: ["runner-terminal", "not-registered"],
        },
        continuationLineage: {
          activeEpisodeId: "episode-live",
          episodes: [
            {
              episodeId: "episode-live",
              continuationSessionId: "runner-live",
              state: "prepared",
              readThroughPlaneSeq: 99,
            },
          ],
        },
        ownerPlaneCursor: { readThroughPlaneSeq: 100 },
      })
    );

    expect(planLegacyConversationRunnerMigration(storage)).toEqual({
      imports: [
        {
          executorScope,
          conversationRootKey,
          runners: [
            {
              runnerSessionId: "runner-live",
              episodeId: "runner-live",
              terminal: false,
            },
            {
              runnerSessionId: "runner-terminal",
              episodeId: "runner-terminal",
              terminal: true,
            },
          ],
        },
      ],
      skippedNonCanonicalEntries: 0,
    });
  });

  it("never guesses pre-canonical roots or unpublished continuation state", () => {
    const storage = new MemoryStorage();
    const oldExecutionKey = JSON.stringify([executorScope, "bare-root-id"]);
    storage.setItem(
      `orgii:conversation-execution-v2:${encodeURIComponent(oldExecutionKey)}`,
      JSON.stringify({
        version: 2,
        runners: { runnerSessionIds: ["runner-old"] },
        continuationLineage: {
          activeEpisodeId: "prepared-old",
          episodes: [
            {
              episodeId: "prepared-old",
              continuationSessionId: "runner-old",
              state: "prepared",
              readThroughPlaneSeq: 42,
            },
          ],
        },
      })
    );
    const oldExecutorKey = JSON.stringify([
      "bare-executor-id",
      conversationRootKey,
    ]);
    storage.setItem(
      `orgii:conversation-execution-v2:${encodeURIComponent(oldExecutorKey)}`,
      JSON.stringify({
        version: 2,
        runners: { runnerSessionIds: ["runner-old-executor"] },
      })
    );

    expect(planLegacyConversationRunnerMigration(storage)).toEqual({
      imports: [],
      skippedNonCanonicalEntries: 2,
    });
  });

  it("lets a valid v2 tombstone own the key instead of reviving v1", () => {
    const storage = new MemoryStorage();
    storage.setItem(entryKey(2), JSON.stringify({ version: 2 }));
    storage.setItem(
      entryKey(1),
      JSON.stringify({
        version: 1,
        runners: { runnerSessionIds: ["stale-v1-runner"] },
      })
    );
    expect(planLegacyConversationRunnerMigration(storage).imports).toEqual([]);
  });
});
