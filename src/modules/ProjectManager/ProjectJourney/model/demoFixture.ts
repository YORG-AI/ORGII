/**
 * Demo fixture so Journey/Tree are usable even when local DB has sparse links.
 */

import type { ProjectLike, WorkItemLike } from "./types";

export const DEMO_PROJECT: ProjectLike = {
  id: "proj-org2-patch-demo",
  name: "ORG2 Patch Demo",
  slug: "org2-patch-demo",
  status: "in_progress",
  description: "Synthetic project for journey/tree smoke demo",
};

export const DEMO_WORK_ITEMS: WorkItemLike[] = [
  {
    session_id: "WI-DEMO-1",
    name: "四级树可感知化",
    status: "completed",
    workItemStatus: "completed",
    spec: "Workspace→Project→WorkItem→Session 树只读聚合",
    created_time: "2026-07-28T10:00:00.000Z",
    updated_time: "2026-07-28T18:00:00.000Z",
    todos: [
      { id: "t1", content: "对齐类型真源", status: "completed" },
      { id: "t2", content: "树聚合 API", status: "completed" },
      { id: "t3", content: "侧栏入口", status: "completed" },
    ],
    linkedSessions: [
      {
        session_id: "sess-main-tree",
        session_type: "native",
        agent_role: "implementer",
        status: "completed",
        started_at: "2026-07-28T10:05:00.000Z",
        completed_at: "2026-07-28T12:00:00.000Z",
      },
    ],
    workProducts: [
      {
        id: "wp1",
        productType: "document",
        path: "docs/org2-patch/PRD.md",
        sessionId: "sess-main-tree",
      },
      {
        id: "wp2",
        productType: "file_change",
        path: "src/modules/ProjectManager/ProjectJourney/model/buildTree.ts",
        sessionId: "sess-main-tree",
      },
    ],
    proofOfWork: {
      diff_stats: {
        files: [
          {
            path: "src/modules/ProjectManager/ProjectJourney/model/buildTree.ts",
            additions: 120,
            deletions: 0,
          },
          {
            path: "docs/org2-patch/PRD.md",
            additions: 200,
            deletions: 0,
          },
        ],
      },
    },
  },
  {
    session_id: "WI-DEMO-2",
    name: "项目旅程思维导图",
    status: "in_progress",
    workItemStatus: "in_progress",
    spec: "主线/分叉/文件闪点/冗余剪枝",
    created_time: "2026-07-28T13:00:00.000Z",
    updated_time: "2026-07-29T01:00:00.000Z",
    todos: [
      { id: "t4", content: "journey graph builder", status: "completed" },
      { id: "t5", content: "file category + blink", status: "in_progress" },
      { id: "t6", content: "prune UX", status: "pending" },
    ],
    linkedSessions: [
      {
        session_id: "sess-main-journey",
        session_type: "native",
        agent_role: "implementer",
        status: "running",
        started_at: "2026-07-28T13:10:00.000Z",
      },
      {
        session_id: "sess-fork-explore",
        session_type: "native",
        agent_role: "explorer",
        status: "completed",
        started_at: "2026-07-28T14:00:00.000Z",
        completed_at: "2026-07-28T15:00:00.000Z",
        parent_session_id: "sess-main-journey",
        sub_agent_name: "explore-alt-layout",
      },
      {
        session_id: "sess-fork-dead",
        session_type: "cli",
        agent_role: "experiment",
        status: "cancelled",
        started_at: "2026-07-28T16:00:00.000Z",
        completed_at: "2026-07-28T16:20:00.000Z",
        parent_session_id: "sess-main-journey",
        sub_agent_name: "dead-end-reactflow",
      },
    ],
    workProducts: [
      {
        id: "wp3",
        productType: "file_change",
        path: "src/modules/ProjectManager/ProjectJourney/model/buildJourney.ts",
        sessionId: "sess-main-journey",
      },
      {
        id: "wp4",
        productType: "screenshot",
        path: "reports/org2-patch/journey-preview.png",
        sessionId: "sess-main-journey",
      },
      {
        id: "wp5",
        productType: "file_change",
        path: "src/modules/ProjectManager/ProjectJourney/model/buildJourney.ts",
        sessionId: "sess-fork-explore",
      },
    ],
    proofOfWork: {
      diff_stats: {
        files: [
          {
            path: "src/modules/ProjectManager/ProjectJourney/model/buildJourney.ts",
            additions: 80,
            deletions: 12,
          },
          {
            path: "reports/org2-patch/journey-preview.png",
            additions: 1,
            deletions: 0,
          },
        ],
      },
    },
  },
];

export function getDemoTreeBundle() {
  return {
    projects: [DEMO_PROJECT],
    workItemsByProject: {
      [DEMO_PROJECT.id]: DEMO_WORK_ITEMS,
      [DEMO_PROJECT.slug!]: DEMO_WORK_ITEMS,
    },
    standaloneWorkItems: [] as WorkItemLike[],
  };
}
