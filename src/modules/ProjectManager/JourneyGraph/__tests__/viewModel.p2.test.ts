import { describe, expect, it } from "vitest";

import type { JourneyGraphPayload } from "@src/api/tauri/journeyGraph";

import {
  graphToBranchesViewModel,
  graphToCoverageLedgerViewModel,
  graphToFileLineageViewModel,
  graphToStorylineViewModel,
} from "../viewModel";

const payload: JourneyGraphPayload = {
  nodes: [
    {
      id: "session/z",
      kind: "session",
      evidenceClass: "canonical",
      sourceRef: "session:z",
      displayTimestamp: "2026-07-30T10:00:00.000Z",
      metadata: {
        agentIdentity: "agent-z",
        agentBand: "review",
        topicTags: ["explicit"],
      },
    },
    {
      id: "session/a",
      kind: "session",
      evidenceClass: "canonical",
      sourceRef: "session:a",
      displayTimestamp: "2026-07-30T08:00:00.000Z",
      metadata: { agentIdentity: "agent-a", agentBand: "build", topicTags: [] },
    },
    {
      id: "turn/a/2",
      kind: "turn",
      evidenceClass: "canonical",
      sourceRef: "turn:a:2",
      displayTimestamp: "2026-07-30T08:30:00.000Z",
    },
    {
      id: "turn/a/1",
      kind: "turn",
      evidenceClass: "canonical",
      sourceRef: "turn:a:1",
      displayTimestamp: "2026-07-30T08:00:00.000Z",
    },
    {
      id: "artifact/orgtrack/a",
      kind: "artifact",
      evidenceClass: "canonical",
      sourceRef: "artifact:a",
    },
    {
      id: "file/repo/src/a.ts",
      kind: "file",
      evidenceClass: "canonical",
      sourceRef: "file:a",
    },
    {
      id: "commit/repo/abc",
      kind: "commit",
      evidenceClass: "canonical",
      sourceRef: "commit:abc",
    },
  ],
  edges: [
    {
      from: "session/a",
      to: "turn/a/1",
      kind: "contains",
      evidenceClass: "canonical",
      sourceRef: "turn:a:1",
    },
    {
      from: "session/a",
      to: "turn/a/2",
      kind: "contains",
      evidenceClass: "canonical",
      sourceRef: "turn:a:2",
    },
    {
      from: "session/z",
      to: "session/a",
      kind: "forkedFrom",
      evidenceClass: "canonical",
      sourceRef: "fork:z:a",
    },
    {
      from: "session/a",
      to: "session/z",
      kind: "resumedFrom",
      evidenceClass: "canonical",
      sourceRef: "resume:a:z",
    },
    {
      from: "artifact/orgtrack/a",
      to: "file/repo/src/a.ts",
      kind: "modified",
      evidenceClass: "canonical",
      sourceRef: "artifact:a",
    },
    {
      from: "session/a",
      to: "commit/repo/abc",
      kind: "committedIn",
      evidenceClass: "canonical",
      sourceRef: "commit:abc",
    },
  ],
  coverage: [
    { sourceRef: "turn:a:1", status: "represented" },
    { sourceRef: "legacy", status: { mergedInto: { target: "turn:a:1" } } },
    { sourceRef: "policy", status: { excluded: { reason: "retention" } } },
  ],
};

describe("P2 Journey view models", () => {
  it("creates explicit idle compression and stable session lanes", () => {
    const view = graphToStorylineViewModel(payload, 10 * 60 * 1000);
    expect(view.lanes.map((lane) => lane.id)).toEqual(["build", "review"]);
    expect(view.lanes[0].milestones.map((milestone) => milestone.id)).toEqual([
      "session/a",
      "turn/a/1",
      "turn/a/2",
    ]);
    expect(view.lanes[0].gaps).toEqual([
      {
        kind: "idleGap",
        fromTimestamp: "2026-07-30T08:00:00.000Z",
        toTimestamp: "2026-07-30T08:30:00.000Z",
        durationMs: 30 * 60 * 1000,
      },
    ]);
    expect(view.unpositioned.map((item) => item.id)).toContain(
      "artifact/orgtrack/a"
    );
    expect(view.lanes[0].milestones[0].topicTags).toEqual([]);
    expect(view.lanes[0].milestones[1].sequence).toBeNull();
  });

  it("uses actual branch edges only, never timestamp proximity", () => {
    const graph = {
      ...payload,
      edges: payload.edges.filter(
        (edge) => edge.kind !== "forkedFrom" && edge.kind !== "resumedFrom"
      ),
    };
    expect(graphToBranchesViewModel(graph).links).toEqual([]);
    expect(
      graphToBranchesViewModel(payload).links.map((link) => link.kind)
    ).toEqual(["resumedFrom", "forkedFrom"]);
  });

  it("keeps absent agent and topic metadata unknown instead of deriving it from ids", () => {
    const graph: JourneyGraphPayload = {
      ...payload,
      nodes: [
        {
          id: "session/sdeagent-review",
          kind: "session",
          evidenceClass: "canonical",
          sourceRef: "session:s",
          displayTimestamp: "2026-07-30T08:00:00.000Z",
        },
      ],
      edges: [],
    };
    const view = graphToStorylineViewModel(graph);
    expect(view.lanes).toHaveLength(1);
    expect(view.lanes[0].id).toBe("unknown-agent");
    expect(view.lanes[0].milestones[0].topicTags).toEqual([]);
  });

  it("uses the explicit session node kind instead of a session-id prefix", () => {
    const graph: JourneyGraphPayload = {
      ...payload,
      nodes: [
        {
          id: "opaque-owner",
          kind: "session",
          evidenceClass: "canonical",
          sourceRef: "session:opaque",
          displayTimestamp: "2026-07-30T08:00:00.000Z",
          metadata: {
            agentIdentity: "agent-a",
            agentBand: "build",
            topicTags: [],
          },
        },
        {
          id: "opaque-turn",
          kind: "turn",
          evidenceClass: "canonical",
          sourceRef: "turn:opaque",
          displayTimestamp: "2026-07-30T08:01:00.000Z",
        },
      ],
      edges: [
        {
          from: "opaque-owner",
          to: "opaque-turn",
          kind: "contains",
          evidenceClass: "canonical",
          sourceRef: "turn:opaque",
        },
      ],
    };

    expect(graphToStorylineViewModel(graph).lanes[0].id).toBe("build");
  });

  it("includes only produced or modified edges connected to factual file nodes", () => {
    const graph: JourneyGraphPayload = {
      ...payload,
      edges: [
        ...payload.edges,
        {
          from: "session/a",
          to: "commit/repo/abc",
          kind: "produced",
          evidenceClass: "canonical",
          sourceRef: "not-a-file",
        },
      ],
    };
    const view = graphToFileLineageViewModel(graph);
    expect(view.links).toEqual([
      {
        from: "artifact/orgtrack/a",
        to: "file/repo/src/a.ts",
        kind: "modified",
        evidenceClass: "canonical",
        sourceRef: "artifact:a",
      },
    ]);
    expect(view.files.map((file) => file.id)).toEqual(["file/repo/src/a.ts"]);
  });

  it("keeps coverage and independent provenance state separate", () => {
    const view = graphToCoverageLedgerViewModel(payload);
    expect(view.summary).toEqual({
      represented: 1,
      mergedInto: 1,
      excluded: 1,
      uncovered: 0,
    });
    expect(
      view.entries.find((entry) => entry.sourceRef === "policy")?.detail
    ).toBe("Excluded: retention");
    expect(view.provenanceAudit).toBe("notProvided");
  });

  it("fails closed for uncovered coverage", () => {
    expect(() =>
      graphToCoverageLedgerViewModel({
        ...payload,
        coverage: [
          ...payload.coverage,
          { sourceRef: "missing", status: "uncovered" },
        ],
      })
    ).toThrow("incomplete");
  });
});
