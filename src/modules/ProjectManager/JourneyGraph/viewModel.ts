import type { JourneyGraphPayload } from "@src/api/tauri/journeyGraph";

export interface JourneyViewModel {
  nodes: Array<{
    id: string;
    title: string;
    kind: string;
    evidenceClass: string;
    sourceRef: string;
  }>;
  files: string[];
}

/** Pure presentation mapping. It cannot infer or repair graph facts. */
export function graphToJourneyViewModel(
  graph: JourneyGraphPayload
): JourneyViewModel {
  if (graph.coverage.some((entry) => entry.status === "uncovered"))
    throw new Error("Journey graph coverage is incomplete");
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      title: node.id.split("/").slice(1).join("/"),
      kind: node.kind,
      evidenceClass: node.evidenceClass,
      sourceRef: node.sourceRef,
    })),
    files: graph.nodes
      .filter((node) => node.kind === "file")
      .map((node) => node.id),
  };
}
