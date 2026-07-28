import { describe, expect, it } from "vitest";

import {
  buildProjectJourneyGraph,
  nodesTouchedByFile,
  filterFiles,
} from "../model/buildJourney";
import {
  buildWorkspaceProjectTree,
  countByKind,
} from "../model/buildTree";
import { classifyPath } from "../model/fileCategory";
import { DEMO_PROJECT, DEMO_WORK_ITEMS } from "../model/demoFixture";
import {
  emptyJourneyState,
  loadJourneyState,
  saveJourneyState,
  togglePinNode,
  togglePruneNode,
} from "../model/journeyState";

describe("classifyPath", () => {
  it("classifies produced vs production sources", () => {
    expect(classifyPath("docs/org2-patch/PRD.md")).toBe("produced");
    expect(classifyPath("reports/a/report.html")).toBe("produced");
    expect(
      classifyPath(
        "src/modules/ProjectManager/ProjectJourney/model/buildTree.ts"
      )
    ).toBe("touched_production");
    expect(classifyPath("random.bin")).toBe("other");
  });
});

describe("buildWorkspaceProjectTree", () => {
  it("builds workspace → project → work item → todo/session", () => {
    const tree = buildWorkspaceProjectTree({
      projects: [DEMO_PROJECT],
      workItemsByProject: { [DEMO_PROJECT.id]: DEMO_WORK_ITEMS },
    });
    expect(tree.kind).toBe("workspace");
    expect(tree.children[0]?.kind).toBe("project");
    const counts = countByKind(tree);
    expect(counts.work_item).toBe(2);
    expect(counts.session).toBeGreaterThanOrEqual(3);
    expect(counts.todo).toBeGreaterThanOrEqual(5);
  });

  it("puts standalone items into Unassigned", () => {
    const tree = buildWorkspaceProjectTree({
      projects: [],
      workItemsByProject: {},
      standaloneWorkItems: DEMO_WORK_ITEMS,
    });
    expect(tree.children[0]?.kind).toBe("unassigned");
    expect(tree.children[0]?.children).toHaveLength(2);
  });
});

describe("buildProjectJourneyGraph", () => {
  it("suggests mainline from work products and marks forks", () => {
    const graph = buildProjectJourneyGraph({
      project: DEMO_PROJECT,
      workItems: DEMO_WORK_ITEMS,
    });
    expect(graph.nodes.some((n) => n.isMainline)).toBe(true);
    expect(graph.nodes.some((n) => n.kind === "fork")).toBe(true);
    expect(graph.stats.producedFileCount).toBeGreaterThan(0);
    expect(graph.stats.touchedProductionFileCount).toBeGreaterThan(0);
    expect(graph.mainlineProgress).toBeGreaterThan(0);
  });

  it("highlights sessions for overlapping file paths", () => {
    const graph = buildProjectJourneyGraph({
      project: DEMO_PROJECT,
      workItems: DEMO_WORK_ITEMS,
    });
    const path =
      "src/modules/ProjectManager/ProjectJourney/model/buildJourney.ts";
    const nodeIds = nodesTouchedByFile(graph, path);
    expect(nodeIds.length).toBeGreaterThanOrEqual(2);
    const produced = filterFiles(graph, "produced");
    expect(produced.every((f) => f.category === "produced")).toBe(true);
  });

  it("applies pin and prune state", () => {
    let state = emptyJourneyState(DEMO_PROJECT.id);
    state = togglePinNode(state, "wi:WI-DEMO-2");
    state = togglePruneNode(state, "session:sess-fork-dead");
    const graph = buildProjectJourneyGraph({
      project: DEMO_PROJECT,
      workItems: DEMO_WORK_ITEMS,
      state,
    });
    expect(
      graph.nodes.find((n) => n.id === "wi:WI-DEMO-2")?.isMainline
    ).toBe(true);
    expect(
      graph.nodes.find((n) => n.id === "session:sess-fork-dead")?.pruned
    ).toBe(true);
  });
});

describe("journeyState storage", () => {
  it("round-trips through a memory storage", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };
    const saved = saveJourneyState(
      {
        ...emptyJourneyState("p1"),
        pinnedMainlineNodeIds: ["a"],
      },
      storage
    );
    const loaded = loadJourneyState("p1", storage);
    expect(loaded.pinnedMainlineNodeIds).toEqual(["a"]);
    expect(loaded.updatedAt).toBe(saved.updatedAt);
  });
});
