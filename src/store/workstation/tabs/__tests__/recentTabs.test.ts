import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import { RECENT_TABS_LIMIT } from "@src/shared/tabs/recentTabs";

import {
  recentWorkstationTabEntriesAtom,
  recordRecentWorkstationTabAtom,
} from "../recentTabs";

describe("recent Workstation tab history", () => {
  it("keeps one global bound across every session workspace", () => {
    const store = createStore();

    for (let index = 0; index < RECENT_TABS_LIMIT + 2; index += 1) {
      store.set(recordRecentWorkstationTabAtom, {
        workspace: { kind: "session", sessionId: `session-${index}` },
        tab: {
          id: `file-${index}`,
          type: "file",
          title: `File ${index}`,
          data: { filePath: `/tmp/file-${index}.ts` },
        },
      });
    }

    const entries = store.get(recentWorkstationTabEntriesAtom);
    expect(entries).toHaveLength(RECENT_TABS_LIMIT);
    expect(entries.map((entry) => entry.workspace)).toEqual([
      { kind: "session", sessionId: "session-6" },
      { kind: "session", sessionId: "session-5" },
      { kind: "session", sessionId: "session-4" },
      { kind: "session", sessionId: "session-3" },
      { kind: "session", sessionId: "session-2" },
    ]);
  });
});
