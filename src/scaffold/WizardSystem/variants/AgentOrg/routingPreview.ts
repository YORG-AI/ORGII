/**
 * Pure routing-rule preview shared by `AgentTeamWizard` and `OrgDetailView`.
 *
 * This is a TS mirror of `AgentOrgRunContext::check_routing` in
 * `src-tauri/src/agent_core/core/coordination/agent_org_runs.rs`. The
 * Rust side is the runtime source of truth — `org_send_message`
 * enforces these rules at send time. This module exists so the
 * wizard can show users a Strict-mode reachability preview *before*
 * anything launches, and surface "isolated member" warnings while
 * the org is being edited.
 *
 * Parity invariant: every rule branch here has a corresponding
 * `routing_strict_*` test in `agent_org_runs::tests`. If the Rust
 * rules change, the matching parity test in this folder will fail
 * and force the two implementations to be re-synced.
 */
import type {
  HierarchyMode,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";

export type RoutingDecision = "allowed" | "blocked";

/**
 * Flat view of a single org member used by the routing preview. The
 * coordinator is represented as the entry whose `id` matches
 * `coordinatorId` — exactly one such entry must exist.
 */
interface PreviewNode {
  id: string;
  name: string;
  parentId: string | null;
}

interface PreviewGraph {
  /** `id` of the coordinator node (root of the OrgMember tree). */
  coordinatorId: string;
  nodes: PreviewNode[];
  hierarchyMode: HierarchyMode;
}

/**
 * Build a `PreviewGraph` from a wizard-side root `OrgMember`.
 *
 * The wizard root is always the coordinator (we don't allow editing
 * the root row directly; it inherits the org's identity). Children
 * are walked depth-first; every entry's `parentId` points at its
 * immediate manager, with the coordinator's children using the
 * coordinator's id as their parent.
 *
 * `hierarchyMode` overrides whatever might be stamped on the root
 * `OrgMember` so the wizard can preview a different mode without
 * mutating state. When `undefined`, falls back to the root's mode
 * or `"soft"` (matches `DEFAULT_HIERARCHY_MODE`).
 */
export function buildPreviewGraph(
  root: OrgMember,
  hierarchyMode?: HierarchyMode
): PreviewGraph {
  const nodes: PreviewNode[] = [
    { id: root.id, name: root.name, parentId: null },
  ];

  function walk(parent: OrgMember) {
    for (const child of parent.children) {
      if (child.role === "org") {
        walk(child);
        continue;
      }
      nodes.push({
        id: child.id,
        name: child.name,
        parentId: parent.id,
      });
      walk(child);
    }
  }
  walk(root);

  return {
    coordinatorId: root.id,
    nodes,
    hierarchyMode: hierarchyMode ?? root.hierarchyMode ?? "soft",
  };
}

/**
 * Pure routing decision for a `from -> to` send under the graph's
 * `hierarchyMode`. Mirrors `check_routing` in Rust:
 *
 * - `flat` / `soft` → always `"allowed"`.
 * - `strict`:
 *   1. anyone → coordinator → allowed (escalate)
 *   2. coordinator → anyone → allowed (escape hatch)
 *   3. from.parentId === to.id → allowed (report to manager)
 *   4. to.parentId === from.id → allowed (manager to direct report)
 *   else → `"blocked"`.
 *
 * `from === to` is treated as `"blocked"` (self-routing) rather than
 * exposing it as an entry in the matrix; callers should skip the
 * diagonal when displaying.
 */
export function decideRouting(
  graph: PreviewGraph,
  fromId: string,
  toId: string
): RoutingDecision {
  if (fromId === toId) return "blocked";
  if (graph.hierarchyMode === "flat" || graph.hierarchyMode === "soft") {
    return "allowed";
  }
  const coord = graph.coordinatorId;
  if (toId === coord || fromId === coord) return "allowed";

  const from = graph.nodes.find((node) => node.id === fromId);
  const to = graph.nodes.find((node) => node.id === toId);
  if (!from || !to) return "blocked";

  if (from.parentId === to.id) return "allowed";
  if (to.parentId === from.id) return "allowed";
  return "blocked";
}

/**
 * Identify members that are "isolated" under Strict mode: they have
 * exactly one reachable peer (the coordinator) and therefore cannot
 * collaborate horizontally. The coordinator itself is excluded —
 * isolation is only meaningful for non-root members.
 *
 * Returns an empty array under Flat / Soft.
 */
export function findIsolatedMemberIds(graph: PreviewGraph): string[] {
  if (graph.hierarchyMode !== "strict") return [];
  const isolated: string[] = [];
  for (const node of graph.nodes) {
    if (node.id === graph.coordinatorId) continue;
    const reachableNonCoord = graph.nodes.filter(
      (other) =>
        other.id !== node.id &&
        other.id !== graph.coordinatorId &&
        decideRouting(graph, node.id, other.id) === "allowed"
    );
    if (reachableNonCoord.length === 0) {
      isolated.push(node.id);
    }
  }
  return isolated;
}
