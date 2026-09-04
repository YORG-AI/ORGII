/**
 * Chat-panel selection state: what the slot is currently pointed at (create
 * target, work item, project, project org, workspace, cloud org, Explore) and
 * the workspace-overview sub-tab.
 */
import { atom } from "jotai";

import type { Project } from "@src/types/core/project";
import type { WorkItem } from "@src/types/core/workItem";
import type { ProjectOrgSurfaceView } from "@src/types/ui/projectOrg";

//
// The docked chat-panel slot can host either the live session view or
// Settings. Which one occupies the slot is fully URL-derived (any
// `/orgii/app/settings/*` path → Settings; otherwise → session), so
// there is no atom for it — `AppLayout`/`AppShell` compute the mode
// directly from `useLocation()` and pass it down. The only persistent
// axis is "maximized", which is orthogonal to the mode and survives
// reloads.

/**
 * What content occupies the chat-panel slot. Derived from the URL by
 * the layout shell; this type is exported only as a wire format for the
 * shell → layout prop hand-off.
 */
export type ChatPanelMode = "session" | "settings";

export const CHAT_PANEL_CREATE_TARGET = {
  AGENT_SESSION: "agentSession",
  /** One prompt, several harnesses, started at once and compared after. */
  PARALLEL_RUN: "parallelRun",
  PROJECT: "project",
  WORK_ITEM: "workItem",
} as const;

export type ChatPanelCreateTarget =
  (typeof CHAT_PANEL_CREATE_TARGET)[keyof typeof CHAT_PANEL_CREATE_TARGET];

export const DEFAULT_CHAT_PANEL_CREATE_TARGET: ChatPanelCreateTarget =
  CHAT_PANEL_CREATE_TARGET.AGENT_SESSION;

export const chatPanelCreateTargetAtom = atom<ChatPanelCreateTarget>(
  DEFAULT_CHAT_PANEL_CREATE_TARGET
);
chatPanelCreateTargetAtom.debugLabel = "chatPanelCreateTargetAtom";

export const chatPanelStartPageOpenAtom = atom<boolean>(true);
chatPanelStartPageOpenAtom.debugLabel = "chatPanelStartPageOpenAtom";

export interface ChatPanelCreateProjectContext {
  orgId: string;
  scopeBreadcrumbLabel?: string;
}

export const chatPanelCreateProjectContextAtom =
  atom<ChatPanelCreateProjectContext | null>(null);
chatPanelCreateProjectContextAtom.debugLabel =
  "chatPanelCreateProjectContextAtom";

export const CHAT_PANEL_CONTENT_MODE = {
  SESSION: "session",
  NON_SESSION: "nonSession",
} as const;

export type ChatPanelContentMode =
  (typeof CHAT_PANEL_CONTENT_MODE)[keyof typeof CHAT_PANEL_CONTENT_MODE];

export const chatPanelContentModeAtom = atom<ChatPanelContentMode>(
  CHAT_PANEL_CONTENT_MODE.SESSION
);
chatPanelContentModeAtom.debugLabel = "chatPanelContentModeAtom";

export interface ChatPanelSelectedWorkItem {
  workItem: WorkItem;
  projectId: string;
  projectName: string;
  projectSlug: string;
  shortId: string;
  orgId?: string;
  orgName?: string;
  sourceProject?: {
    project: Project;
    projectSlug: string;
    orgId: string;
    orgName?: string;
  };
}

export const chatPanelSelectedWorkItemAtom =
  atom<ChatPanelSelectedWorkItem | null>(null);
chatPanelSelectedWorkItemAtom.debugLabel = "chatPanelSelectedWorkItemAtom";

export interface ChatPanelSelectedProject {
  project: Project;
  projectSlug: string;
  projectSyncAdapterId?: string | null;
  orgId: string;
  orgName?: string;
}

export const chatPanelSelectedProjectAtom =
  atom<ChatPanelSelectedProject | null>(null);
chatPanelSelectedProjectAtom.debugLabel = "chatPanelSelectedProjectAtom";

export interface ChatPanelSelectedProjectOrg {
  orgId: string;
  orgName: string;
  orgScope: "personal_org" | "project_org";
  orgSyncProvider?: string | null;
  /** Optional surface requested by the action opening/focusing this ORG. */
  initialView?: ProjectOrgSurfaceView;
  /** Changes when an opener explicitly requests `initialView` again. */
  initialViewRequestId?: number;
}

export const chatPanelSelectedProjectOrgAtom =
  atom<ChatPanelSelectedProjectOrg | null>(null);
chatPanelSelectedProjectOrgAtom.debugLabel = "chatPanelSelectedProjectOrgAtom";

export interface ChatPanelSelectedWorkspace {
  kind: "workspace" | "repo";
  id: string;
  name: string;
  path?: string;
  folderCount?: number;
  repoIds?: string[];
}

export const chatPanelSelectedWorkspaceAtom =
  atom<ChatPanelSelectedWorkspace | null>(null);
chatPanelSelectedWorkspaceAtom.debugLabel = "chatPanelSelectedWorkspaceAtom";

/**
 * Managed ORG2 Cloud org selected for the CLOUD_ORG management panel
 * (cloud orgs come from the managed backend, `org2CloudOrgsAtom`).
 */
export interface ChatPanelSelectedCloudOrg {
  orgId: string;
  /** Optional management surface requested by the action opening this ORG. */
  initialView?: CloudOrgManagementView;
  /** Changes when an opener explicitly requests `initialView` again. */
  initialViewRequestId?: number;
}

export type CloudOrgManagementView = "general" | "sync" | "members";

export const CLOUD_ORG_MANAGEMENT_VIEW = {
  GENERAL: "general",
  SYNC: "sync",
  MEMBERS: "members",
} as const satisfies Record<string, CloudOrgManagementView>;

/** The explicit provider variant owned by the shared organization tab. */
export type ChatPanelSelectedOrganization =
  | {
      kind: "cloud";
      cloudOrg: ChatPanelSelectedCloudOrg;
    }
  | {
      kind: "local";
      projectOrg: ChatPanelSelectedProjectOrg;
    };

export const chatPanelSelectedCloudOrgAtom =
  atom<ChatPanelSelectedCloudOrg | null>(null);
chatPanelSelectedCloudOrgAtom.debugLabel = "chatPanelSelectedCloudOrgAtom";

/**
 * Whether the chat-panel slot is rendering the GitHub repo search /
 * "Explore" view. Mutually exclusive with the workspace dashboard,
 * project, work item, and session surfaces at the render layer
 * (precedence enforced in `ChatPanel/index.tsx`). Entry points that
 * open Explore must clear those sibling atoms.
 */
export const chatPanelExploreOpenAtom = atom<boolean>(false);
chatPanelExploreOpenAtom.debugLabel = "chatPanelExploreOpenAtom";

/**
 * Selected tab on the chat-panel workspace overview surface
 * (`WorkspaceOverviewPanelView`). The overview/details split is
 * orthogonal to which workspace is selected; entry points that drill
 * into a specific repo (e.g. the dashboard's "Open details" button)
 * set this to `"details"` along with `chatPanelSelectedWorkspaceAtom`.
 *
 * Persisted only in-memory — switching between workspace overview
 * targets preserves the selected tab unless navigation explicitly
 * requests a different tab.
 */
export const WORKSPACE_OVERVIEW_TAB = {
  OVERVIEW: "overview",
  DETAILS: "details",
} as const;

export type WorkspaceOverviewTab =
  (typeof WORKSPACE_OVERVIEW_TAB)[keyof typeof WORKSPACE_OVERVIEW_TAB];

export const chatPanelWorkspaceOverviewTabAtom = atom<WorkspaceOverviewTab>(
  WORKSPACE_OVERVIEW_TAB.OVERVIEW
);
chatPanelWorkspaceOverviewTabAtom.debugLabel =
  "chatPanelWorkspaceOverviewTabAtom";
