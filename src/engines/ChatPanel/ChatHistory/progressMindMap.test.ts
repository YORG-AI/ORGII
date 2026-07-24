import { describe, expect, it } from "vitest";

import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";
import type { Session } from "@src/store/session";

import { buildProgressMindMap } from "./progressMindMap";

function turn(index: number): TurnSummary {
  return {
    sessionId: "root",
    turnId: `t${index}`,
    startSequence: index,
    endSequence: index + 1,
    nextTurnId: null,
    startedAt: `2026-07-25T00:00:0${index}Z`,
    endedAt: null,
    durationMs: 1000,
    userEventIds: [],
    userPreview: `Step ${index}`,
    eventCount: index + 1,
    bodyEventCount: index,
    status: "completed",
    interrupted: false,
    modifiedFiles:
      index === 2
        ? [
            {
              path: "src/a.ts",
              fileName: "a.ts",
              status: "modified",
              additions: 2,
              deletions: 1,
            },
          ]
        : [],
  };
}

describe("buildProgressMindMap", () => {
  it("sorts a deterministic main line and preserves real file changes", () => {
    const graph = buildProgressMindMap([turn(2), turn(0), turn(1)]);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "turn:t0",
      "turn:t1",
      "turn:t2",
    ]);
    expect(graph.edges.map((edge) => edge.kind)).toEqual(["main", "main"]);
    expect(graph.nodes[2].files[0]?.path).toBe("src/a.ts");
  });

  it("adds fork edges from real child sessions", () => {
    const child = {
      session_id: "child",
      parentSessionId: "root",
      status: "running",
      created_at: "2026-07-25T00:01:00Z",
      updated_at: "2026-07-25T00:01:00Z",
      name: "Implement UI",
      touchedFiles: ["src/ui.tsx"],
    } as Session;
    const graph = buildProgressMindMap([turn(0)], [child]);
    expect(graph.nodes.at(-1)).toMatchObject({
      id: "fork:child",
      kind: "fork",
      status: "running",
    });
    expect(graph.edges.at(-1)).toMatchObject({
      from: "turn:t0",
      to: "fork:child",
      kind: "fork",
    });
  });

  it("aggregates the oldest turns for large sessions", () => {
    const graph = buildProgressMindMap([turn(0), turn(1), turn(2)], [], 2);
    expect(graph.hiddenTurns).toBe(1);
    expect(graph.nodes[0]).toMatchObject({
      kind: "aggregate",
      label: "1 earlier steps",
    });
  });
});
