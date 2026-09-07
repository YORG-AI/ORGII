export interface TodoEntry {
  id: string;
  content: string;
  /** "pending" | "in_progress" | "completed" */
  status: string;
}

export interface CommentEntry {
  id: string;
  author: string;
  content: string;
  created_at: string;
  /** Per-comment optimistic concurrency token; legacy comments start at 0. */
  revision?: number;
  /** Canonical member ids explicitly notified by this comment. */
  mentioned_user_ids?: string[];
  mentions?: Array<
    | { kind: "member"; id: string }
    | { kind: "agent"; id: string }
    | { kind: "agent_org"; id: string }
    | { kind: "all" }
  >;
  parent_id?: string;
  thread_id?: string;
  resolved_at?: string;
  resolved_by?: string;
  conclusion?: boolean;
  agent_session_id?: string;
  /** A2A chain: who caused the authoring agent's run. */
  originator?: string;
  edited_at?: string;
  /** Tombstone: content and mentions are cleared, the entry stays. */
  deleted_at?: string;
}
