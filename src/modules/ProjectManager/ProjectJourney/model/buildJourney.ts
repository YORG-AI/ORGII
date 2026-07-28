/**
 * Build project journey graph from work items + optional narrative state.
 */

import {
  classifyPath,
  classifyWorkProduct,
  workProductPath,
} from "./fileCategory";
import type {
  JourneyEdge,
  JourneyFileRef,
  JourneyNode,
  JourneyNodeStatus,
  LinkedSessionLike,
  ProjectJourneyGraph,
  ProjectJourneyState,
  ProjectLike,
  WorkItemLike,
} from "./types";

export interface BuildJourneyInput {
  project: ProjectLike;
  workItems: WorkItemLike[];
  state?: ProjectJourneyState | null;
  /** Extra file hits from orgtrack: path → sessionIds */
  orgtrackFiles?: Array<{
    path: string;
    sessionIds: string[];
    additions?: number;
    deletions?: number;
  }>;
}

function wiStatus(wi: WorkItemLike): JourneyNodeStatus {
  const raw = (wi.workItemStatus ?? wi.status ?? "").toLowerCase();
  if (
    raw === "completed" ||
    raw === "done" ||
    raw === "closed" ||
    raw === "cancelled" ||
    raw === "canceled" ||
    raw === "duplicate"
  ) {
    return raw === "cancelled" || raw === "canceled" || raw === "duplicate"
      ? "abandoned"
      : "done";
  }
  if (raw === "in_progress" || raw === "in_review" || raw === "open") {
    return "doing";
  }
  return "todo";
}

function sessionNodeStatus(raw?: string): JourneyNodeStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "completed" || s === "done" || s === "success") return "done";
  if (s === "failed" || s === "cancelled" || s === "canceled") return "abandoned";
  if (s === "running" || s === "in_progress" || s === "active") return "doing";
  return "todo";
}

function summarizeWorkItem(wi: WorkItemLike): string {
  const sessions = wi.linkedSessions?.length ?? 0;
  const todos = wi.todos ?? [];
  const doneTodos = todos.filter((t) =>
    ["completed", "done"].includes(t.status.toLowerCase())
  ).length;
  const products = wi.workProducts?.length ?? 0;
  const parts = [
    sessions ? `${sessions} sessions` : null,
    todos.length ? `tasks ${doneTodos}/${todos.length}` : null,
    products ? `${products} products` : null,
  ].filter(Boolean);
  const spec = (wi.spec ?? "").trim();
  if (spec) {
    const one = spec.split("\n").find((l) => l.trim())?.trim() ?? "";
    if (one) parts.unshift(one.slice(0, 80));
  }
  return parts.join(" · ") || "No sessions yet";
}

function pushFile(
  map: Map<string, JourneyFileRef>,
  path: string,
  category: JourneyFileRef["category"],
  sessionId: string | undefined,
  workItemId: string,
  source: JourneyFileRef["source"],
  additions?: number,
  deletions?: number
) {
  const key = path.replace(/\\/g, "/");
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      path: key,
      category,
      sessionIds: sessionId ? [sessionId] : [],
      workItemIds: [workItemId],
      additions,
      deletions,
      source,
    });
    return;
  }
  if (sessionId && !existing.sessionIds.includes(sessionId)) {
    existing.sessionIds.push(sessionId);
  }
  if (!existing.workItemIds.includes(workItemId)) {
    existing.workItemIds.push(workItemId);
  }
  if (additions != null) {
    existing.additions = (existing.additions ?? 0) + additions;
  }
  if (deletions != null) {
    existing.deletions = (existing.deletions ?? 0) + deletions;
  }
  // Prefer stronger category: produced > touched > other
  const rank = { produced: 2, touched_production: 1, other: 0 } as const;
  if (rank[category] > rank[existing.category]) {
    existing.category = category;
  }
}

function collectFiles(
  workItems: WorkItemLike[],
  orgtrackFiles: BuildJourneyInput["orgtrackFiles"]
): JourneyFileRef[] {
  const map = new Map<string, JourneyFileRef>();

  for (const wi of workItems) {
    const fallbackSession = wi.linkedSessions?.[0]?.session_id;
    for (const product of wi.workProducts ?? []) {
      const path = workProductPath(product);
      if (!path) continue;
      pushFile(
        map,
        path,
        classifyWorkProduct(product),
        product.sessionId ?? fallbackSession,
        wi.session_id,
        "work_product"
      );
    }

    const files =
      wi.proofOfWork?.diff_stats?.files ??
      wi.proofOfWork?.diffStats?.files ??
      [];
    for (const f of files) {
      if (!f.path) continue;
      pushFile(
        map,
        f.path,
        classifyPath(f.path),
        fallbackSession,
        wi.session_id,
        "proof_of_work",
        f.additions,
        f.deletions
      );
    }
  }

  for (const hit of orgtrackFiles ?? []) {
    for (const sid of hit.sessionIds) {
      pushFile(
        map,
        hit.path,
        classifyPath(hit.path),
        sid,
        // orgtrack may not know WI; leave empty and fill later via session map
        "",
        "orgtrack",
        hit.additions,
        hit.deletions
      );
    }
  }

  // Drop empty workItem id placeholders
  for (const file of map.values()) {
    file.workItemIds = file.workItemIds.filter(Boolean);
  }

  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function hasWorkProduct(wi: WorkItemLike): boolean {
  if ((wi.workProducts?.length ?? 0) > 0) return true;
  const files =
    wi.proofOfWork?.diff_stats?.files ??
    wi.proofOfWork?.diffStats?.files ??
    [];
  return files.length > 0;
}

function computeRedundancy(
  nodes: JourneyNode[],
  files: JourneyFileRef[]
): void {
  const pathToSessions = new Map<string, Set<string>>();
  for (const f of files) {
    const set = pathToSessions.get(f.path) ?? new Set();
    f.sessionIds.forEach((s) => set.add(s));
    pathToSessions.set(f.path, set);
  }

  const sessionOverlap = new Map<string, number>();
  for (const sessions of pathToSessions.values()) {
    if (sessions.size < 2) continue;
    for (const s of sessions) {
      sessionOverlap.set(s, (sessionOverlap.get(s) ?? 0) + 1);
    }
  }

  for (const node of nodes) {
    if (node.kind !== "session" && node.kind !== "fork") continue;
    let score = 0;
    for (const sid of node.sessionIds) {
      score += sessionOverlap.get(sid) ?? 0;
    }
    // No products and is fork → bump
    if (
      node.kind === "fork" &&
      node.resultFileRefs.length === 0 &&
      !node.isMainline
    ) {
      score += 1;
    }
    node.redundancyScore = score;
  }
}

function filesForSessions(
  files: JourneyFileRef[],
  sessionIds: string[]
): JourneyFileRef[] {
  if (sessionIds.length === 0) return [];
  const set = new Set(sessionIds);
  return files.filter((f) => f.sessionIds.some((s) => set.has(s)));
}

export function buildProjectJourneyGraph(
  input: BuildJourneyInput
): ProjectJourneyGraph {
  const { project, workItems } = input;
  const state = input.state;
  const pinned = new Set(state?.pinnedMainlineNodeIds ?? []);
  const prunedNodes = new Set(state?.prunedNodeIds ?? []);
  const prunedEdges = new Set(state?.prunedEdgeIds ?? []);

  const files = collectFiles(workItems, input.orgtrackFiles);
  const nodes: JourneyNode[] = [];
  const edges: JourneyEdge[] = [];

  const sorted = [...workItems].sort((a, b) => {
    const at = a.created_time ?? a.updated_time ?? "";
    const bt = b.created_time ?? b.updated_time ?? "";
    return at.localeCompare(bt);
  });

  // Suggested mainline: work items that produced artifacts, else chronological spine
  const suggestedWiIds = new Set(
    sorted.filter(hasWorkProduct).map((w) => w.session_id)
  );
  if (suggestedWiIds.size === 0) {
    sorted.forEach((w) => suggestedWiIds.add(w.session_id));
  }

  let prevMainWiNodeId: string | null = null;

  for (const wi of sorted) {
    const wiNodeId = `wi:${wi.session_id}`;
    const suggested = suggestedWiIds.has(wi.session_id);
    const isMainline =
      pinned.size > 0 ? pinned.has(wiNodeId) : suggested;

    const sessionIds = (wi.linkedSessions ?? []).map((s) => s.session_id);
    const wiFiles = files.filter(
      (f) =>
        f.workItemIds.includes(wi.session_id) ||
        f.sessionIds.some((s) => sessionIds.includes(s))
    );

    nodes.push({
      id: wiNodeId,
      title: wi.name || wi.session_id,
      summary: summarizeWorkItem(wi),
      status: wiStatus(wi),
      workItemIds: [wi.session_id],
      sessionIds,
      resultFileRefs: wiFiles,
      isMainline,
      suggestedMainline: suggested,
      redundancyScore: 0,
      pruned: prunedNodes.has(wiNodeId),
      kind: "work_item",
      startedAt: wi.created_time,
      completedAt: wi.updated_time,
    });

    if (prevMainWiNodeId && isMainline) {
      const edgeId = `${prevMainWiNodeId}->${wiNodeId}`;
      edges.push({
        id: edgeId,
        from: prevMainWiNodeId,
        to: wiNodeId,
        kind: "main",
        pruned: prunedEdges.has(edgeId),
      });
    }
    if (isMainline) prevMainWiNodeId = wiNodeId;

    // Session nodes as branches under work item
    const sessions = [...(wi.linkedSessions ?? [])].sort((a, b) =>
      (a.started_at ?? "").localeCompare(b.started_at ?? "")
    );

    const sessionNodeIds = new Map<string, string>();
    for (const ls of sessions) {
      const sid = ls.session_id;
      const nodeId = `session:${sid}`;
      sessionNodeIds.set(sid, nodeId);
      const sFiles = filesForSessions(files, [sid]);
      const isFork = Boolean(ls.parent_session_id);
      const sessionMain =
        pinned.size > 0
          ? pinned.has(nodeId)
          : !isFork && sessions[0]?.session_id === sid;

      nodes.push({
        id: nodeId,
        title:
          ls.sub_agent_name ||
          ls.agent_role ||
          sid.slice(0, 10),
        summary: buildSessionSummary(ls, sFiles.length),
        status: sessionNodeStatus(ls.status),
        workItemIds: [wi.session_id],
        sessionIds: [sid],
        resultFileRefs: sFiles,
        isMainline: sessionMain && isMainline,
        suggestedMainline: !isFork,
        parentNodeId: ls.parent_session_id
          ? sessionNodeIds.get(ls.parent_session_id) ?? wiNodeId
          : wiNodeId,
        branchOf: isFork
          ? sessionNodeIds.get(ls.parent_session_id ?? "") ?? wiNodeId
          : wiNodeId,
        redundancyScore: 0,
        pruned: prunedNodes.has(nodeId),
        kind: isFork ? "fork" : "session",
        startedAt: ls.started_at,
        completedAt: ls.completed_at,
      });

      const parentId =
        ls.parent_session_id && sessionNodeIds.has(ls.parent_session_id)
          ? sessionNodeIds.get(ls.parent_session_id)!
          : wiNodeId;
      const edgeId = `${parentId}->${nodeId}`;
      edges.push({
        id: edgeId,
        from: parentId,
        to: nodeId,
        kind: isFork ? "fork" : "main",
        pruned: prunedEdges.has(edgeId),
        weight: sFiles.reduce(
          (n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0),
          1
        ),
      });
    }
  }

  computeRedundancy(nodes, files);

  const mainlineNodes = nodes.filter(
    (n) => n.isMainline && !n.pruned && n.kind === "work_item"
  );
  const doneMain = mainlineNodes.filter((n) => n.status === "done").length;
  const mainlineProgress =
    mainlineNodes.length === 0 ? 0 : doneMain / mainlineNodes.length;

  return {
    projectId: project.id,
    projectSlug: project.slug,
    projectName: project.name,
    nodes,
    edges,
    files,
    mainlineProgress,
    stats: {
      workItemCount: workItems.length,
      sessionCount: nodes.filter((n) => n.kind === "session" || n.kind === "fork")
        .length,
      producedFileCount: files.filter((f) => f.category === "produced").length,
      touchedProductionFileCount: files.filter(
        (f) => f.category === "touched_production"
      ).length,
      redundantNodeCount: nodes.filter((n) => n.redundancyScore > 0 && !n.pruned)
        .length,
      prunedNodeCount: nodes.filter((n) => n.pruned).length,
    },
  };
}

function buildSessionSummary(
  ls: LinkedSessionLike,
  fileCount: number
): string {
  const parts = [
    ls.status ?? "unknown",
    ls.session_type,
    fileCount ? `${fileCount} files` : null,
    ls.parent_session_id ? "fork" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Sessions to highlight when a file is selected. */
export function sessionsForFile(
  graph: ProjectJourneyGraph,
  filePath: string
): string[] {
  const file = graph.files.find((f) => f.path === filePath);
  return file?.sessionIds ?? [];
}

export function nodesTouchedByFile(
  graph: ProjectJourneyGraph,
  filePath: string
): string[] {
  const sessionIds = new Set(sessionsForFile(graph, filePath));
  return graph.nodes
    .filter(
      (n) =>
        n.sessionIds.some((s) => sessionIds.has(s)) ||
        n.resultFileRefs.some((f) => f.path === filePath)
    )
    .map((n) => n.id);
}

export function filterFiles(
  graph: ProjectJourneyGraph,
  category: "all" | "produced" | "touched_production" | "other"
): JourneyFileRef[] {
  if (category === "all") return graph.files;
  return graph.files.filter((f) => f.category === category);
}
