import { invoke } from "@tauri-apps/api/core";

export type JourneyScope = `project/${string}` | `session/${string}`;
export type EvidenceClass = "canonical" | "derivedRule" | "aiAnnotation" | "userOverlay";
export interface JourneyGraphNode { id: string; kind: string; evidenceClass: EvidenceClass; sourceRef: string; displayTimestamp?: string | null; }
export interface JourneyGraphEdge { from: string; to: string; kind: string; evidenceClass: EvidenceClass; sourceRef: string; }
export type JourneyCoverageStatus = "represented" | "uncovered" | { mergedInto: { target: string } } | { excluded: { reason: string } };
export interface JourneyCoverage { sourceRef: string; status: JourneyCoverageStatus; }
export interface JourneyGraphPayload { nodes: JourneyGraphNode[]; edges: JourneyGraphEdge[]; coverage: JourneyCoverage[]; }

export function assertJourneyScope(scope: string): asserts scope is JourneyScope {
  if (!/^(project|session)\/[^/\s]+$/.test(scope)) throw new Error("Journey scope must be project/{id} or session/{id}");
}

export async function journeyGraphQuery(scope: JourneyScope): Promise<JourneyGraphPayload> {
  assertJourneyScope(scope);
  const graph = await invoke<JourneyGraphPayload>("journey_graph_query", { scope });
  if (graph.coverage.some((entry) => entry.status === "uncovered")) throw new Error("Journey graph is incomplete; refusing partial canonical data");
  for (const item of [...graph.nodes, ...graph.edges]) if (!item.evidenceClass || !item.sourceRef) throw new Error("Journey graph is missing required evidence");
  return graph;
}
