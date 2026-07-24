import type {
  TurnModifiedFile,
  TurnStatus,
  TurnSummary,
} from "@src/engines/SessionCore/storage/sqliteCache";
import type { Session } from "@src/store/session";

export type ProgressMindMapNodeKind = "turn" | "fork" | "aggregate";

export interface ProgressMindMapNode {
  id: string;
  kind: ProgressMindMapNodeKind;
  label: string;
  detail: string;
  status: TurnStatus | string;
  turnId?: string;
  turnIndex?: number;
  files: TurnModifiedFile[];
  eventCount: number;
  startedAt?: string;
}

export interface ProgressMindMapEdge {
  id: string;
  from: string;
  to: string;
  kind: "main" | "fork";
}

export interface ProgressMindMapGraph {
  nodes: ProgressMindMapNode[];
  edges: ProgressMindMapEdge[];
  totalTurns: number;
  hiddenTurns: number;
}

const DEFAULT_LIMIT = 18;

/** Deterministically projects persisted turn-index and child-session records. */
export function buildProgressMindMap(
  turns: readonly TurnSummary[],
  childSessions: readonly Session[] = [],
  limit = DEFAULT_LIMIT
): ProgressMindMapGraph {
  const ordered = [...turns].sort(
    (left, right) =>
      left.startSequence - right.startSequence ||
      left.startedAt.localeCompare(right.startedAt)
  );
  const safeLimit = Math.max(1, limit);
  const hiddenTurns = Math.max(0, ordered.length - safeLimit);
  const visible = hiddenTurns > 0 ? ordered.slice(-safeLimit) : ordered;
  const nodes: ProgressMindMapNode[] = [];
  const edges: ProgressMindMapEdge[] = [];

  if (hiddenTurns > 0) {
    nodes.push({
      id: "aggregate-earlier",
      kind: "aggregate",
      label: `${hiddenTurns} earlier steps`,
      detail: "Collapsed to keep large sessions readable",
      status: "completed",
      files: [],
      eventCount: ordered
        .slice(0, hiddenTurns)
        .reduce((sum, turn) => sum + turn.eventCount, 0),
    });
  }

  visible.forEach((turn, visibleIndex) => {
    const absoluteIndex = hiddenTurns + visibleIndex;
    const nodeId = `turn:${turn.turnId}`;
    nodes.push({
      id: nodeId,
      kind: "turn",
      label: turn.userPreview.trim() || `Step ${absoluteIndex + 1}`,
      detail: buildTurnDetail(turn),
      status: turn.status,
      turnId: turn.turnId,
      turnIndex: absoluteIndex,
      files: turn.modifiedFiles,
      eventCount: turn.eventCount,
      startedAt: turn.startedAt,
    });
    const previous = nodes[nodes.length - 2];
    if (previous) {
      edges.push({
        id: `${previous.id}->${nodeId}`,
        from: previous.id,
        to: nodeId,
        kind: "main",
      });
    }
  });

  const forkSource = [...nodes].reverse().find((node) => node.kind === "turn");
  if (forkSource) {
    [...childSessions]
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .forEach((session) => {
        const id = `fork:${session.session_id}`;
        nodes.push({
          id,
          kind: "fork",
          label:
            session.displayLabel ||
            session.name ||
            session.user_input ||
            "Forked session",
          detail: buildForkDetail(session),
          status: session.status,
          files: (session.touchedFiles ?? []).map((path) => ({
            path,
            fileName: path.split("/").pop() || path,
            status: "modified" as const,
            additions: 0,
            deletions: 0,
          })),
          eventCount: 0,
        });
        const source = resolveForkSource(nodes, session.created_at);
        edges.push({
          id: `${source.id}->${id}`,
          from: source.id,
          to: id,
          kind: "fork",
        });
      });
  }

  return { nodes, edges, totalTurns: ordered.length, hiddenTurns };
}

function buildTurnDetail(turn: TurnSummary): string {
  const parts = [`${turn.eventCount} events`];
  if (turn.modifiedFiles.length > 0)
    parts.push(`${turn.modifiedFiles.length} files`);
  if (turn.durationMs != null)
    parts.push(`${Math.max(1, Math.round(turn.durationMs / 1000))}s`);
  return parts.join(" · ");
}

function buildForkDetail(session: Session): string {
  const parts = ["Fork branch"];
  if (session.agentRole) parts.push(String(session.agentRole));
  if ((session.touchedFiles?.length ?? 0) > 0)
    parts.push(`${session.touchedFiles?.length ?? 0} files`);
  return parts.join(" · ");
}

function resolveForkSource(
  nodes: readonly ProgressMindMapNode[],
  childCreatedAt: string
): ProgressMindMapNode {
  const childTime = Date.parse(childCreatedAt);
  const turnNodes = nodes.filter(
    (node): node is ProgressMindMapNode & { turnIndex: number } =>
      node.kind === "turn" && node.turnIndex != null
  );
  if (Number.isFinite(childTime)) {
    const preceding = [...turnNodes].reverse().find((node) => {
      const turnTime = Date.parse(node.startedAt ?? "");
      return Number.isFinite(turnTime) && turnTime <= childTime;
    });
    if (preceding) return preceding;
  }
  // Parent-session linkage is persisted, but legacy records may not have a
  // usable timestamp. Latest persisted turn is the deterministic fallback.
  return turnNodes.at(-1) ?? nodes[0];
}
