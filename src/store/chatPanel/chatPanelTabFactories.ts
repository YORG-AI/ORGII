/**
 * Concrete Chat Panel tab factories.
 *
 * One `create<Type>Tab` per `ChatPanelTabType`, built on
 * `defineChatPanelTabFactory`. Open atoms (`chatPanelTabOpenAtoms.ts`) and the
 * lifecycle/default builders route every tab construction through these so the
 * id scheme, stored title, and typed payload for each type live in exactly one
 * place. Dedup (focus-or-create) stays in the open atoms, which need store
 * access; the factories only mint fresh tabs.
 */
import type {
  ChatPanelSelectedOrganization,
  ChatPanelSelectedProject,
  ChatPanelSelectedWorkItem,
  ChatPanelSelectedWorkspace,
} from "@src/store/ui/chatPanelAtom";
import type { WorkManagementSection } from "@src/store/workstation/workstationTabBarAtoms";

import { defineChatPanelTabFactory } from "./chatPanelTabFactory";
import {
  type ChatPanelTab,
  type ChatPanelTabsState,
  ORGANIZATION_TAB_ID,
  getWorkManagementFallbackTitle,
} from "./chatPanelTabsModel";

/** Fixed id of the singleton default Launchpad seeded on empty / restart. */
export const DEFAULT_LAUNCHPAD_TAB_ID = "launchpad-default";
/** Prefix for section-keyed Work Management tabs. */
export const WORK_MANAGEMENT_TAB_ID_PREFIX = "chat-work-management";
/** Fixed id of the singleton Runtime tab. */
export const RUNTIME_TAB_ID = "chat-runtime";
/** Fixed id of the singleton Team Inbox tab. */
export const TEAM_INBOX_TAB_ID = "chat-team-inbox";

// ---------------------------------------------------------------------------
// start-page (Launchpad)
// ---------------------------------------------------------------------------

/** The singleton default Launchpad tab seeded on init / close-to-empty. */
export const createDefaultLaunchpadTab = defineChatPanelTabFactory<void>({
  tabType: "start-page",
  idStrategy: { type: "fixed", id: DEFAULT_LAUNCHPAD_TAB_ID },
  getTitle: () => "Launchpad",
});

/** A user-added Launchpad tab (distinct instance from the default singleton). */
export const createLaunchpadTab = defineChatPanelTabFactory<{ title?: string }>(
  {
    tabType: "start-page",
    idStrategy: { type: "uuid", prefix: "launchpad" },
    getTitle: (data) => data.title ?? "Launchpad",
  }
);

// ---------------------------------------------------------------------------
// work-management — one tab per sidebar section
// ---------------------------------------------------------------------------

export const createWorkManagementTab = defineChatPanelTabFactory<{
  section: WorkManagementSection;
  title?: string;
}>({
  tabType: "work-management",
  idStrategy: {
    type: "keyed",
    prefix: WORK_MANAGEMENT_TAB_ID_PREFIX,
    getKey: (data) => data.section,
  },
  getTitle: (data) =>
    data.title ?? getWorkManagementFallbackTitle(data.section),
  toPayload: (data) => ({ managementSection: data.section }),
});

// ---------------------------------------------------------------------------
// runtime — singleton
// ---------------------------------------------------------------------------

export const createRuntimeTab = defineChatPanelTabFactory<{ title?: string }>({
  tabType: "runtime",
  idStrategy: { type: "fixed", id: RUNTIME_TAB_ID },
  getTitle: (data) => data.title ?? "Runtime",
});

// ---------------------------------------------------------------------------
// team-inbox — singleton
// ---------------------------------------------------------------------------

export const createTeamInboxTab = defineChatPanelTabFactory<{ title?: string }>(
  {
    tabType: "team-inbox",
    idStrategy: { type: "fixed", id: TEAM_INBOX_TAB_ID },
    getTitle: (data) => data.title ?? "Team Inbox",
  }
);

// ---------------------------------------------------------------------------
// workspace (overview) — one pill per workspace, deduped by openers
// ---------------------------------------------------------------------------

export const createWorkspaceTab = defineChatPanelTabFactory<{
  workspace: ChatPanelSelectedWorkspace;
}>({
  tabType: "workspace",
  idStrategy: { type: "uuid", prefix: "workspace" },
  getTitle: (data) => data.workspace.name,
  toPayload: (data) => ({ workspace: data.workspace }),
});

// ---------------------------------------------------------------------------
// organization (cloud/local management and hub) — singleton
// ---------------------------------------------------------------------------

export const createOrganizationTab = defineChatPanelTabFactory<{
  organization: ChatPanelSelectedOrganization;
  title?: string;
}>({
  tabType: "organization",
  idStrategy: { type: "fixed", id: ORGANIZATION_TAB_ID },
  getTitle: (data) => data.title ?? "Manage ORG",
  toPayload: (data) => ({ organization: data.organization }),
});

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

export const createSessionTab = defineChatPanelTabFactory<{
  sessionId?: string | null;
  title?: string;
}>({
  tabType: "session",
  idStrategy: { type: "uuid", prefix: "chat" },
  getTitle: (data) => data.title ?? "Chat",
  toPayload: (data) => ({ sessionId: data.sessionId }),
});

// ---------------------------------------------------------------------------
// terminal
// ---------------------------------------------------------------------------

export const createTerminalTab = defineChatPanelTabFactory<{
  terminalSessionId: string;
  title?: string;
  cliCommand?: string;
}>({
  tabType: "terminal",
  idStrategy: { type: "uuid", prefix: "terminal" },
  getTitle: (data) => data.title ?? "Terminal",
  toPayload: (data) => ({
    terminalSessionId: data.terminalSessionId,
    cliCommand: data.cliCommand,
  }),
});

// ---------------------------------------------------------------------------
// work-item — one pill per work item, deduped by shortId
// ---------------------------------------------------------------------------

export const createWorkItemTab = defineChatPanelTabFactory<{
  workItem: ChatPanelSelectedWorkItem;
}>({
  tabType: "work-item",
  idStrategy: {
    type: "keyed",
    prefix: "work-item",
    getKey: (data) => data.workItem.shortId,
  },
  getTitle: (data) => data.workItem.workItem.name || "Work item",
  toPayload: (data) => ({ workItem: data.workItem }),
});

// ---------------------------------------------------------------------------
// project — one pill per project, deduped by slug
// ---------------------------------------------------------------------------

export const createProjectTab = defineChatPanelTabFactory<{
  project: ChatPanelSelectedProject;
}>({
  tabType: "project",
  idStrategy: {
    type: "keyed",
    prefix: "project",
    getKey: (data) => data.project.projectSlug,
  },
  getTitle: (data) => data.project.project.name || "Project",
  toPayload: (data) => ({ project: data.project }),
});

// ---------------------------------------------------------------------------
// explore — singleton (no payload)
// ---------------------------------------------------------------------------

export const createExploreTab = defineChatPanelTabFactory<void>({
  tabType: "explore",
  idStrategy: { type: "fixed", id: "chat-explore" },
  getTitle: () => "Explore",
});

// ---------------------------------------------------------------------------
// Default / initial state builders (moved here so all tab construction is
// funnelled through the factories).
// ---------------------------------------------------------------------------

/** Build the fixed-id singleton Launchpad tab shown on empty / restart. */
export function buildDefaultLaunchpadTab(): ChatPanelTab {
  return createDefaultLaunchpadTab();
}

/** Seed the pane with a single fresh Launchpad tab. */
export function buildInitialChatPanelTabsState(): ChatPanelTabsState {
  const launchpad = buildDefaultLaunchpadTab();
  return {
    tabs: [launchpad],
    activeTabId: launchpad.id,
  };
}
