import { describe, expect, it, vi } from "vitest";
import { journeyGraphQuery } from "@src/api/tauri/journeyGraph";
import { graphToJourneyViewModel } from "../viewModel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

const payload = { nodes: [{ id: "session/s", kind: "session", evidenceClass: "canonical", sourceRef: "session:s" }], edges: [], coverage: [{ sourceRef: "session:s", status: "represented" }] } as const;
describe("shared journey graph", () => {
  it("uses the same command payload for project and session scopes", async () => { vi.mocked(invoke).mockResolvedValue(payload); expect(await journeyGraphQuery("project/p")).toEqual(payload); expect(await journeyGraphQuery("session/s")).toEqual(payload); expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1,"journey_graph_query",{scope:"project/p"}); });
  it("surfaces evidence and fails closed on partial coverage", () => { expect(graphToJourneyViewModel(payload).nodes[0].evidenceClass).toBe("canonical"); expect(() => graphToJourneyViewModel({ ...payload, coverage: [{ sourceRef: "session:s", status: "uncovered" }] })).toThrow("incomplete"); });
});
