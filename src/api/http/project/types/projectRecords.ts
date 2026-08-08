import type { AgentDefaults } from "./agentWorkflow";

export interface ProjectOrg {
  id: string;
  name: string;
  slug: string;
  org_key: string;
  source: string;
  sync_provider: string;
  sync_config_json?: string;
  sync_connection_id?: string;
  external_org_id?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectOrgRequest {
  name: string;
  id?: string;
}

/**
 * Mirrors `ProjectMeta` in Rust. `linked_repos` is an optional set of
 * repo identifiers used purely as a filter dimension by the Project
 * manager sidebar — projects are NOT scoped to a single repo.
 */
export interface ProjectMeta {
  id: string;
  name: string;
  org_id: string;
  status: string;
  priority: string;
  health: string;
  lead?: string;
  members: string[];
  labels: string[];
  linked_repos: string[];
  start_date?: string;
  target_date?: string;
  created_at: string;
  updated_at: string;
  /** Per-project auto-increment counter for work item IDs (starts at 1) */
  next_work_item_id: number;
  /** 3-char alphanumeric prefix for work item IDs (e.g. "AUT") */
  work_item_prefix: string;
  /** True when user manually set prefix; false when auto-derived from project name */
  work_item_prefix_custom: boolean;
  /** Project-level defaults for agent workflows (inherited by new work items) */
  agent_defaults?: AgentDefaults;
}

export interface ProjectData {
  meta: ProjectMeta;
  description: string;
  slug: string;
  /** Bound external sync adapter. Absent for local-only projects. */
  sync_adapter_id?: string;
}
