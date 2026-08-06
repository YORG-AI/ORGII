import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { JourneyGraphPayload } from "@src/api/tauri/journeyGraph";

import { BranchesGraph } from "../components/BranchesGraph";
import { CoverageLedger } from "../components/CoverageLedger";
import { FileLineagePanel } from "../components/FileLineagePanel";
import { StorylineTimeline } from "../components/StorylineTimeline";
import {
  graphToBranchesViewModel,
  graphToCoverageLedgerViewModel,
  graphToFileLineageViewModel,
  graphToStorylineViewModel,
} from "../viewModel";

const graph: JourneyGraphPayload = {
  nodes: [
    {
      id: "session/s",
      kind: "session",
      evidenceClass: "canonical",
      sourceRef: "session:s",
      displayTimestamp: "2026-07-30T08:00:00.000Z",
      metadata: { topicTags: ["explicit-topic"] },
    },
    {
      id: "session/parent",
      kind: "session",
      evidenceClass: "canonical",
      sourceRef: "session:parent",
      displayTimestamp: "2026-07-30T07:00:00.000Z",
    },
    {
      id: "artifact/orgtrack/a",
      kind: "artifact",
      evidenceClass: "canonical",
      sourceRef: "artifact:a",
    },
    {
      id: "file/repo/a.ts",
      kind: "file",
      evidenceClass: "canonical",
      sourceRef: "file:a",
    },
  ],
  edges: [
    {
      from: "session/s",
      to: "session/parent",
      kind: "forkedFrom",
      evidenceClass: "canonical",
      sourceRef: "fork:s:parent",
    },
    {
      from: "artifact/orgtrack/a",
      to: "file/repo/a.ts",
      kind: "produced",
      evidenceClass: "canonical",
      sourceRef: "artifact:a",
    },
  ],
  coverage: [{ sourceRef: "session:s", status: "represented" }],
};

describe("P2 Journey components", () => {
  it("renders evidence badges and source drill targets for every graph view", () => {
    const markup = [
      renderToStaticMarkup(
        createElement(StorylineTimeline, {
          viewModel: graphToStorylineViewModel(graph),
        })
      ),
      renderToStaticMarkup(
        createElement(BranchesGraph, {
          viewModel: graphToBranchesViewModel(graph),
        })
      ),
      renderToStaticMarkup(
        createElement(FileLineagePanel, {
          viewModel: graphToFileLineageViewModel(graph),
        })
      ),
      renderToStaticMarkup(
        createElement(CoverageLedger, {
          viewModel: graphToCoverageLedgerViewModel(graph),
        })
      ),
    ].join("\n");
    expect(markup).toContain("canonical");
    expect(markup).toContain("Source: session:s");
    expect(markup).toContain("#journey-source-session%3As");
    expect(markup).toContain("Independent provenance audit");
    expect(markup).toContain("explicit-topic");
  });

  it("does not render unknown or non-canonical topic tags", () => {
    const unknownGraph: JourneyGraphPayload = {
      ...graph,
      nodes: [
        {
          id: "session/unknown",
          kind: "session",
          evidenceClass: "canonical",
          sourceRef: "session:unknown",
          displayTimestamp: "2026-07-30T08:00:00.000Z",
        },
        {
          id: "session/overlay",
          kind: "session",
          evidenceClass: "userOverlay",
          sourceRef: "overlay",
          displayTimestamp: "2026-07-30T09:00:00.000Z",
          metadata: { topicTags: ["not-canonical"] },
        },
      ],
      edges: [],
    };

    const markup = renderToStaticMarkup(
      createElement(StorylineTimeline, {
        viewModel: graphToStorylineViewModel(unknownGraph),
      })
    );
    expect(markup).not.toContain("storyline-topic-tags");
    expect(markup).not.toContain("not-canonical");
  });
});
