/**
 * Project Journey / Tree — shared types
 *
 * Narrative layer only. Does NOT own project/session membership truth.
 * Truth remains: Project → WorkItem → linkedSessions (+ todos as fine tasks).
 */

export type TreeNodeKind =
  | "workspace"
  | "project"
  | "work_item"
  | "todo"
  | "session"
  | "unassigned";

export interface ProjectTreeNode {
  id: string;
  kind: TreeNodeKind;
  title: string;
  status?: string;
  projectId?: string;
  projectSlug?: string;
  workItemId?: string;
  sessionId?: string;
  children: ProjectTreeNode[];
  meta?: Record<string, unknown>;
}

export type JourneyNodeStatus = "todo" | "doing" | "done" | "abandoned";

export type JourneyFileCategory = "produced" | "touched_production" | "other";

export interface JourneyFileRef {
  path: string;
  category: JourneyFileCategory;
  sessionIds: string[];
  workItemIds: string[];
  additions?: number;
  deletions?: number;
  source?: "work_product" | "proof_of_work" | "orgtrack" | "todo" | "inferred";
}

export interface JourneyNode {
  id: string;
  title: string;
  summary: string;
  status: JourneyNodeStatus;
  workItemIds: string[];
  sessionIds: string[];
  resultFileRefs: JourneyFileRef[];
  isMainline: boolean;
  suggestedMainline: boolean;
  parentNodeId?: string;
  branchOf?: string;
  redundancyScore: number;
  pruned: boolean;
  kind: "work_item" | "session" | "todo_cluster" | "fork";
  startedAt?: string;
  completedAt?: string;
}

export interface JourneyEdge {
  id: string;
  from: string;
  to: string;
  kind: "main" | "fork" | "file";
  pruned: boolean;
  weight?: number;
}

export interface ProjectJourneyGraph {
  projectId: string;
  projectSlug?: string;
  projectName: string;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  files: JourneyFileRef[];
  mainlineProgress: number;
  stats: {
    workItemCount: number;
    sessionCount: number;
    producedFileCount: number;
    touchedProductionFileCount: number;
    redundantNodeCount: number;
    prunedNodeCount: number;
  };
}

export interface ProjectJourneyState {
  version: 1;
  projectId: string;
  pinnedMainlineNodeIds: string[];
  prunedNodeIds: string[];
  prunedEdgeIds: string[];
  updatedAt: string;
}

export interface LinkedSessionLike {
  session_id: string;
  session_type?: string;
  agent_role?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  parent_session_id?: string | null;
  sub_agent_name?: string | null;
  cost_usd?: number | null;
  total_tokens?: number | null;
}

export interface TodoLike {
  id: string;
  content: string;
  status: string;
}

export interface WorkProductLike {
  id?: string;
  productType?: string;
  type?: string;
  title?: string;
  path?: string;
  uri?: string;
  url?: string;
  status?: string;
  sessionId?: string;
  metadata?: Record<string, unknown> | null;
}

export interface FileChangeLike {
  path: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

export interface WorkItemLike {
  session_id: string;
  name: string;
  status?: string;
  workItemStatus?: string;
  spec?: string;
  project?: { id: string; name: string } | null;
  linkedSessions?: LinkedSessionLike[];
  todos?: TodoLike[];
  workProducts?: WorkProductLike[];
  proofOfWork?: {
    diff_stats?: {
      files?: FileChangeLike[];
    };
    diffStats?: {
      files?: FileChangeLike[];
    };
  } | null;
  created_time?: string;
  updated_time?: string;
}

export interface ProjectLike {
  id: string;
  name: string;
  slug?: string;
  status?: string;
  description?: string;
}

export const JOURNEY_STATE_VERSION = 1 as const;
export const JOURNEY_STATE_KEY_PREFIX = "org2.projectJourney.v1:";
