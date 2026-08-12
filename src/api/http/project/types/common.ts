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
  /** Canonical member ids explicitly notified by this comment. */
  mentioned_user_ids?: string[];
  parent_id?: string;
  thread_id?: string;
  resolved_at?: string;
  resolved_by?: string;
  conclusion?: boolean;
  agent_session_id?: string;
}
