import { type WritableAtom, atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import {
  clampChatWidth,
  clampVisibleChatWidth,
} from "@src/engines/ChatPanel/config";
import {
  settingsAtom,
  updateSettingAtom,
} from "@src/store/settings/settingsAtom";
import type { Project } from "@src/types/core/project";
import type { WorkItem } from "@src/types/core/workItem";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

// ============================================
// Chat Panel Layout Atoms
// ============================================
// High-frequency state atoms for chat panel dimensions and visibility.
// Use Jotai instead of Context to avoid excessive re-rendering.

/**
 * Chat width - persisted across sessions
 * Now unified across all views (workstation, session workspace, kanban)
 *
 * OPTIMIZED: Uses debounced localStorage writes to prevent blocking UI
 */

// Debounce timer for localStorage writes
export const DEFAULT_CHAT_WIDTH = 520;

let chatWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastVisibleChatWidth = DEFAULT_CHAT_WIDTH;
const CHAT_WIDTH_SAVE_DELAY = 300; // ms

// CSS variable name for direct DOM updates
const CHAT_WIDTH_CSS_VAR = "--orgii-chat-width";
// Clamp persisted widths to the current responsive range; preserve the 0
// sentinel which means "chat panel hidden".
const ChatWidthSchema = z.number().transform((value) => {
  if (value <= 0) return 0;
  return clampVisibleChatWidth(value);
});
const StationChatVisibilitySchema = z.object({
  "my-station": z.boolean(),
  "agent-station": z.boolean(),
});

export type StationChatVisibility = z.infer<typeof StationChatVisibilitySchema>;
export type ChatStationMode = keyof StationChatVisibility;

// Load initial value from localStorage (only once at startup).
// Clamp to the responsive width range so values persisted from wider viewports
// don't overflow, and immediately write the clamped value back so the next
// reload is clean.
const getInitialChatWidth = (): number => {
  if (typeof window === "undefined") return DEFAULT_CHAT_WIDTH;
  try {
    const storedValue = localStorage.getItem("globalChatWidth");
    const parsed =
      storedValue !== null ? JSON.parse(storedValue) : DEFAULT_CHAT_WIDTH;
    const width = ChatWidthSchema.safeParse(parsed).data ?? DEFAULT_CHAT_WIDTH;
    if (width !== parsed) {
      localStorage.setItem("globalChatWidth", JSON.stringify(width));
    }
    return width;
  } catch {
    localStorage.setItem("globalChatWidth", JSON.stringify(DEFAULT_CHAT_WIDTH));
    return DEFAULT_CHAT_WIDTH;
  }
};

// Initialize CSS variable on module load (before any component renders)
const initialChatWidth = getInitialChatWidth();
lastVisibleChatWidth =
  initialChatWidth > 0 ? initialChatWidth : DEFAULT_CHAT_WIDTH;
if (typeof document !== "undefined") {
  document.documentElement.style.setProperty(
    CHAT_WIDTH_CSS_VAR,
    `${initialChatWidth}px`
  );
}

// Base atom for in-memory state (fast updates, no persistence)
const chatWidthBaseAtom = atom<number>(initialChatWidth);
chatWidthBaseAtom.debugLabel = "chatWidthBaseAtom";

/**
 * Chat width atom with optimized persistence
 * - Reads from base atom (fast)
 * - Writes update base atom immediately + debounced localStorage write
 * - Also updates CSS variable directly for instant visual feedback
 */
export const chatWidthAtom = atom(
  (get) => get(chatWidthBaseAtom),
  (_get, set, newWidth: number) => {
    const clampedWidth = clampChatWidth(newWidth);

    set(chatWidthBaseAtom, clampedWidth);

    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty(
        CHAT_WIDTH_CSS_VAR,
        `${clampedWidth}px`
      );
    }

    if (clampedWidth <= 0) return;

    lastVisibleChatWidth = clampedWidth;
    if (chatWidthSaveTimer) {
      clearTimeout(chatWidthSaveTimer);
    }
    chatWidthSaveTimer = setTimeout(() => {
      localStorage.setItem("globalChatWidth", JSON.stringify(clampedWidth));
      chatWidthSaveTimer = null;
    }, CHAT_WIDTH_SAVE_DELAY);
  }
);
chatWidthAtom.debugLabel = "chatWidthAtom";

export const restoreChatWidthAtom = atom(null, (_get, set) => {
  set(chatWidthAtom, lastVisibleChatWidth || DEFAULT_CHAT_WIDTH);
});
restoreChatWidthAtom.debugLabel = "restoreChatWidthAtom";

/**
 * Derived atom for chat visibility only
 * OPTIMIZED: Only triggers re-render when visibility changes (0 <-> non-zero)
 * Components that only need to know if chat is visible should use this
 */
export const chatVisibleAtom = atom((get) => get(chatWidthBaseAtom) > 0);
chatVisibleAtom.debugLabel = "chatVisibleAtom";

export const stationChatVisibilityAtom = atomWithStorage<StationChatVisibility>(
  "stationChatVisibility",
  {
    "my-station": true,
    "agent-station": true,
  },
  createZodJsonStorage(StationChatVisibilitySchema),
  { getOnInit: true }
);
stationChatVisibilityAtom.debugLabel = "stationChatVisibilityAtom";

export const activeStationChatVisibleAtom = atom(
  (get) => (mode: ChatStationMode) => get(stationChatVisibilityAtom)[mode],
  (_get, set, mode: ChatStationMode, visible: boolean) => {
    set(stationChatVisibilityAtom, (prev) => ({
      ...prev,
      [mode]: visible,
    }));
    if (visible) {
      set(restoreChatWidthAtom);
    } else {
      set(chatWidthAtom, 0);
    }
  }
);
activeStationChatVisibleAtom.debugLabel = "activeStationChatVisibleAtom";

/**
 * Per-session opt-in for the Agent Team group chat view. Holds the
 * coordinator session id whose ChatPanel is currently rendering the
 * group view (or `null` for none). Non-persistent: closing or
 * switching session reverts to the per-member ChatHistory default,
 * matching the user's preference that the dropdown choice not stick.
 *
 * Stored as a single-id atom (not a `Set`) because exactly one chat
 * panel surface is active at a time — secondary surfaces (kanban
 * detail, project manager tab) render a different `ChatView` instance
 * and should not inherit the parent's group-view selection.
 */
export const groupChatViewSessionIdAtom = atom<string | null>(null);
groupChatViewSessionIdAtom.debugLabel = "groupChatViewSessionIdAtom";

/** Whether chat history is displayed as turn-based rounds. */
export const chatTurnPaginationEnabledAtom = atom(
  (get) => get(settingsAtom)["general.chatTurnPaginationEnabled"] as boolean,
  (_get, set, value: boolean) => {
    set(updateSettingAtom, {
      key: "general.chatTurnPaginationEnabled",
      value,
    });
  }
);
chatTurnPaginationEnabledAtom.debugLabel = "chatTurnPaginationEnabledAtom";

export type ChatHistoryDisplayMode = "full" | "compact";

const ChatHistoryDisplayModeSchema = z.enum(["full", "compact"]);

export const chatHistoryDisplayModeAtom =
  atomWithStorage<ChatHistoryDisplayMode>(
    "orgii:chatHistoryDisplayMode",
    "compact",
    createZodJsonStorage(ChatHistoryDisplayModeSchema),
    { getOnInit: true }
  );
chatHistoryDisplayModeAtom.debugLabel = "chatHistoryDisplayModeAtom";

/** Presentation style for the chat panel model picker. */
export type ModelPickerStyle = "spotlight" | "dropdown";

/**
 * Whether the chat panel model pill opens the full Spotlight palette
 * (`"spotlight"`) or a compact anchored dropdown (`"dropdown"`).
 */
export const modelPickerStyleAtom = atom(
  (get) => get(settingsAtom)["general.modelPickerStyle"] as ModelPickerStyle,
  (_get, set, value: ModelPickerStyle) => {
    set(updateSettingAtom, {
      key: "general.modelPickerStyle",
      value,
    });
  }
);
modelPickerStyleAtom.debugLabel = "modelPickerStyleAtom";

// ============================================
// Chat Panel Slot Mode / Maximized
// ============================================
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
  MANAGE_AGENTS: "manageAgents",
  PROJECT: "project",
  WORK_ITEM: "workItem",
  COLLAB_ORG: "collabOrg",
  BENCHMARK: "benchmark",
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
  BENCHMARK_SESSION_GROUP: "benchmarkSessionGroup",
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

export interface ChatPanelSelectedCollabOrg {
  orgId: string;
  memberId?: string;
}

export const chatPanelSelectedCollabOrgAtom =
  atom<ChatPanelSelectedCollabOrg | null>(null);
chatPanelSelectedCollabOrgAtom.debugLabel = "chatPanelSelectedCollabOrgAtom";

export const chatPanelWorkspaceDashboardOpenAtom = atom<boolean>(false);
chatPanelWorkspaceDashboardOpenAtom.debugLabel =
  "chatPanelWorkspaceDashboardOpenAtom";

/**
 * Whether the chat-panel slot is rendering the GitHub repo search /
 * "Explore" view. Mutually exclusive with the workspace dashboard,
 * project, work item, and session surfaces at the render layer
 * (precedence enforced in `ChatPanel/index.tsx`). Entry points that
 * open Explore must clear those sibling atoms.
 */
export const chatPanelExploreOpenAtom = atom<boolean>(false);
chatPanelExploreOpenAtom.debugLabel = "chatPanelExploreOpenAtom";

export const chatPanelExploreAgentSearchEnabledAtom = atom<boolean>(false);
chatPanelExploreAgentSearchEnabledAtom.debugLabel =
  "chatPanelExploreAgentSearchEnabledAtom";

export const chatPanelManageIssuesOpenAtom = atom<boolean>(false);
chatPanelManageIssuesOpenAtom.debugLabel = "chatPanelManageIssuesOpenAtom";

/**
 * Selected tab on the chat-panel workspace overview surface
 * (`WorkspaceOverviewPanelView`). The overview/details/recent-session/agent-blame split is
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
  RECENT_SESSION: "recentSession",
  AGENT_BLAME: "agentBlame",
} as const;

export type WorkspaceOverviewTab =
  (typeof WORKSPACE_OVERVIEW_TAB)[keyof typeof WORKSPACE_OVERVIEW_TAB];

export const chatPanelWorkspaceOverviewTabAtom = atom<WorkspaceOverviewTab>(
  WORKSPACE_OVERVIEW_TAB.OVERVIEW
);
chatPanelWorkspaceOverviewTabAtom.debugLabel =
  "chatPanelWorkspaceOverviewTabAtom";

export const CHAT_PANEL_SURFACE_KIND = {
  SESSION: "session",
  BENCHMARK_SESSION_GROUP: "benchmarkSessionGroup",
  NEW_PROJECT: "newProject",
  NEW_WORK_ITEM: "newWorkItem",
  NEW_COLLAB_ORG: "newCollabOrg",
  PROJECT: "project",
  PROJECT_ORG: "projectOrg",
  WORK_ITEM: "workItem",
  WORKSPACE_DASHBOARD: "workspaceDashboard",
  WORKSPACE_EXPLORE: "workspaceExplore",
  MANAGE_ISSUES: "manageIssues",
  WORKSPACE_OVERVIEW: "workspaceOverview",
  COLLAB_ORG: "collabOrg",
} as const;

export type ChatPanelSurfaceKind =
  (typeof CHAT_PANEL_SURFACE_KIND)[keyof typeof CHAT_PANEL_SURFACE_KIND];

export type ChatPanelSurfaceState =
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.SESSION }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.BENCHMARK_SESSION_GROUP }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_PROJECT }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_COLLAB_ORG }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.PROJECT;
      project: ChatPanelSelectedProject;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.PROJECT_ORG;
      projectOrg: ChatPanelSelectedProjectOrg;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.WORK_ITEM;
      workItem: ChatPanelSelectedWorkItem;
    }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_DASHBOARD }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.MANAGE_ISSUES }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW;
      workspace: ChatPanelSelectedWorkspace;
      tab: WorkspaceOverviewTab;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.COLLAB_ORG;
      collabOrg: ChatPanelSelectedCollabOrg;
    };

export type ChatPanelNavigateCommand =
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.SESSION }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.BENCHMARK_SESSION_GROUP }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_PROJECT;
      createProjectContext?: ChatPanelCreateProjectContext | null;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM;
      createProjectContext?: ChatPanelCreateProjectContext | null;
    }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_COLLAB_ORG }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.PROJECT;
      project: ChatPanelSelectedProject;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.PROJECT_ORG;
      projectOrg: ChatPanelSelectedProjectOrg;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.WORK_ITEM;
      workItem: ChatPanelSelectedWorkItem;
    }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_DASHBOARD }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.MANAGE_ISSUES }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW;
      workspace: ChatPanelSelectedWorkspace;
      tab?: WorkspaceOverviewTab;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.COLLAB_ORG;
      collabOrg: ChatPanelSelectedCollabOrg;
    };

type SetAtom = <Value, Args extends unknown[], Result>(
  atomToSet: WritableAtom<Value, Args, Result>,
  ...args: Args
) => Result;

function resetChatPanelSurfaceState(set: SetAtom): void {
  set(chatPanelSelectedWorkItemAtom, null);
  set(chatPanelSelectedProjectAtom, null);
  set(chatPanelSelectedProjectOrgAtom, null);
  set(chatPanelSelectedWorkspaceAtom, null);
  set(chatPanelSelectedCollabOrgAtom, null);
  set(chatPanelWorkspaceDashboardOpenAtom, false);
  set(chatPanelExploreOpenAtom, false);
  set(chatPanelManageIssuesOpenAtom, false);
  set(chatPanelCreateProjectContextAtom, null);
  set(chatPanelCreateTargetAtom, DEFAULT_CHAT_PANEL_CREATE_TARGET);
  set(chatPanelWorkspaceOverviewTabAtom, WORKSPACE_OVERVIEW_TAB.OVERVIEW);
}

export const chatPanelNavigateAtom = atom(
  null,
  (get, set, command: ChatPanelNavigateCommand) => {
    const currentWorkspaceOverviewTab = get(chatPanelWorkspaceOverviewTabAtom);
    resetChatPanelSurfaceState(set);
    set(chatPanelStartPageOpenAtom, false);

    switch (command.kind) {
      case CHAT_PANEL_SURFACE_KIND.SESSION:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.SESSION);
        return;
      case CHAT_PANEL_SURFACE_KIND.BENCHMARK_SESSION_GROUP:
        set(
          chatPanelContentModeAtom,
          CHAT_PANEL_CONTENT_MODE.BENCHMARK_SESSION_GROUP
        );
        return;
      case CHAT_PANEL_SURFACE_KIND.NEW_PROJECT:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelCreateTargetAtom, CHAT_PANEL_CREATE_TARGET.PROJECT);
        set(
          chatPanelCreateProjectContextAtom,
          command.createProjectContext ?? null
        );
        return;
      case CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelCreateTargetAtom, CHAT_PANEL_CREATE_TARGET.WORK_ITEM);
        set(
          chatPanelCreateProjectContextAtom,
          command.createProjectContext ?? null
        );
        return;
      case CHAT_PANEL_SURFACE_KIND.NEW_COLLAB_ORG:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelCreateTargetAtom, CHAT_PANEL_CREATE_TARGET.COLLAB_ORG);
        return;
      case CHAT_PANEL_SURFACE_KIND.PROJECT:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedProjectAtom, command.project);
        return;
      case CHAT_PANEL_SURFACE_KIND.PROJECT_ORG:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedProjectOrgAtom, command.projectOrg);
        return;
      case CHAT_PANEL_SURFACE_KIND.WORK_ITEM:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedWorkItemAtom, command.workItem);
        return;
      case CHAT_PANEL_SURFACE_KIND.WORKSPACE_DASHBOARD:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelWorkspaceDashboardOpenAtom, true);
        return;
      case CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelExploreOpenAtom, true);
        return;
      case CHAT_PANEL_SURFACE_KIND.MANAGE_ISSUES:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelManageIssuesOpenAtom, true);
        return;
      case CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedWorkspaceAtom, command.workspace);
        set(
          chatPanelWorkspaceOverviewTabAtom,
          command.tab ?? currentWorkspaceOverviewTab
        );
        return;
      case CHAT_PANEL_SURFACE_KIND.COLLAB_ORG:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedCollabOrgAtom, command.collabOrg);
        return;
    }
  }
);
chatPanelNavigateAtom.debugLabel = "chatPanelNavigateAtom";

export const activeChatPanelSurfaceAtom = atom<ChatPanelSurfaceState>((get) => {
  const contentMode = get(chatPanelContentModeAtom);
  if (contentMode === CHAT_PANEL_CONTENT_MODE.BENCHMARK_SESSION_GROUP) {
    return { kind: CHAT_PANEL_SURFACE_KIND.BENCHMARK_SESSION_GROUP };
  }

  const selectedWorkItem = get(chatPanelSelectedWorkItemAtom);
  if (selectedWorkItem) {
    return {
      kind: CHAT_PANEL_SURFACE_KIND.WORK_ITEM,
      workItem: selectedWorkItem,
    };
  }

  const selectedProject = get(chatPanelSelectedProjectAtom);
  if (selectedProject) {
    return { kind: CHAT_PANEL_SURFACE_KIND.PROJECT, project: selectedProject };
  }

  const selectedProjectOrg = get(chatPanelSelectedProjectOrgAtom);
  if (selectedProjectOrg) {
    return {
      kind: CHAT_PANEL_SURFACE_KIND.PROJECT_ORG,
      projectOrg: selectedProjectOrg,
    };
  }

  if (get(chatPanelWorkspaceDashboardOpenAtom)) {
    return { kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_DASHBOARD };
  }

  if (get(chatPanelExploreOpenAtom)) {
    return { kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE };
  }

  if (get(chatPanelManageIssuesOpenAtom)) {
    return { kind: CHAT_PANEL_SURFACE_KIND.MANAGE_ISSUES };
  }

  const selectedWorkspace = get(chatPanelSelectedWorkspaceAtom);
  if (selectedWorkspace) {
    return {
      kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW,
      workspace: selectedWorkspace,
      tab: get(chatPanelWorkspaceOverviewTabAtom),
    };
  }

  const selectedCollabOrg = get(chatPanelSelectedCollabOrgAtom);
  if (selectedCollabOrg) {
    return {
      kind: CHAT_PANEL_SURFACE_KIND.COLLAB_ORG,
      collabOrg: selectedCollabOrg,
    };
  }

  const createTarget = get(chatPanelCreateTargetAtom);
  if (
    contentMode === CHAT_PANEL_CONTENT_MODE.NON_SESSION &&
    createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT
  ) {
    return { kind: CHAT_PANEL_SURFACE_KIND.NEW_PROJECT };
  }
  if (
    contentMode === CHAT_PANEL_CONTENT_MODE.NON_SESSION &&
    createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM
  ) {
    return { kind: CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM };
  }
  if (
    contentMode === CHAT_PANEL_CONTENT_MODE.NON_SESSION &&
    createTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG
  ) {
    return { kind: CHAT_PANEL_SURFACE_KIND.NEW_COLLAB_ORG };
  }

  return { kind: CHAT_PANEL_SURFACE_KIND.SESSION };
});
activeChatPanelSurfaceAtom.debugLabel = "activeChatPanelSurfaceAtom";

/**
 * Whether the chat-panel slot covers the entire main content area.
 * Maximizing is purely a slot-side affordance; the underlying station
 * mode never changes, so un-maximize requires no bookkeeping. Persisted
 * so a maximized layout survives reloads.
 */
export const chatPanelMaximizedAtom = atomWithStorage<boolean>(
  "orgii:chatPanelMaximized",
  false,
  createZodJsonStorage(z.boolean()),
  { getOnInit: true }
);
chatPanelMaximizedAtom.debugLabel = "chatPanelMaximizedAtom";

/** Write-only toggle for the maximized state. */
export const toggleChatPanelMaximizedAtom = atom(null, (get, set) => {
  set(chatPanelMaximizedAtom, !get(chatPanelMaximizedAtom));
});
toggleChatPanelMaximizedAtom.debugLabel = "toggleChatPanelMaximizedAtom";

// ============================================
// Replay Slider Atoms
// ============================================

/**
 * Replay display value while dragging
 * High frequency updates, does not trigger Context re-render
 */
export const replayDisplayValueAtom = atom<number>(200);
replayDisplayValueAtom.debugLabel = "replayDisplayValueAtom";

/**
 * Whether Replay is currently being dragged
 */
export const replayIsDraggingAtom = atom<boolean>(false);
replayIsDraggingAtom.debugLabel = "replayIsDraggingAtom";

// ============================================
// Chat Panel Visibility / Read-Only
// ============================================

/** Whether the chat-related dropdown UI is open */
export const chatDropDownShowAtom = atom<boolean>(false);
chatDropDownShowAtom.debugLabel = "chatDropDownShowAtom";

/** Whether the chat panel / workspace is in read-only mode */
export const wpReadOnlyAtom = atom<boolean>(true);
wpReadOnlyAtom.debugLabel = "wpReadOnlyAtom";
