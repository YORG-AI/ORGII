import type {
  ChatPanelSelectedCloudOrg,
  ChatPanelSelectedProject,
  ChatPanelSelectedProjectOrg,
  ChatPanelSelectedWorkItem,
  ChatPanelSelectedWorkspace,
} from "@src/store/ui/chatPanelAtom";
import {
  WORK_MANAGEMENT_SECTION,
  type WorkManagementSection,
} from "@src/store/workstation/workstationTabBarAtoms";

export type ChatPanelTabType =
  | "session"
  | "terminal"
  | "start-page"
  | "runtime"
  | "work-management"
  | "workspace"
  | "cloud-org"
  | "work-item"
  | "project"
  | "project-org"
  | "explore";

export interface ChatPanelTab {
  id: string;
  type: ChatPanelTabType;
  /** Display label */
  title: string;
  /** Sidebar section owned by this Work Management tab. */
  managementSection?: WorkManagementSection;
  createdAt?: string;
  updatedAt?: string;
  /**
   * For "session" tabs: the linked ORGII session ID.
   * Legacy persisted empty tabs may still hydrate with null before migration.
   */
  sessionId?: string | null;
  /**
   * For "terminal" tabs: the terminal session ID in the shared terminal
   * atom store. Always prefixed "chatpanel-<uuid>" to isolate from
   * Workstation terminals.
   */
  terminalSessionId?: string;
  /**
   * When true the terminal / session output is forced through xterm.js
   * instead of ansi-to-react.
   */
  tuiMode?: boolean;
  /**
   * For "terminal" tabs opened via the CLI launch bar: the bare binary command
   * to write to the PTY once the shell prompt is ready (e.g. "claude\n").
   * Written once after the PTY reports initialized; cleared afterwards.
   */
  cliCommand?: string;
  /**
   * For "workspace" tabs: the workspace whose overview / detail page this pill
   * owns. Activating the tab replays this into `chatPanelSelectedWorkspaceAtom`
   * (via `chatPanelNavigateAtom`) so the overview surface re-renders.
   */
  workspace?: ChatPanelSelectedWorkspace;
  /**
   * For "cloud-org" tabs: the managed organization restored when this tab
   * is activated. The management page itself provides the org switcher.
   */
  cloudOrg?: ChatPanelSelectedCloudOrg;
  /**
   * For "work-item" tabs: the linked work item plus its project/org context.
   * Writable in place — the work-item panel edits/refreshes this payload.
   */
  workItem?: ChatPanelSelectedWorkItem;
  /**
   * For "project" tabs: the linked project plus its slug/org context. The
   * panel self-fetches the project's work items from `project.projectSlug`.
   */
  project?: ChatPanelSelectedProject;
  /**
   * For "project-org" tabs: the linked local / project organization whose hub
   * (work items etc.) this pill owns.
   */
  projectOrg?: ChatPanelSelectedProjectOrg;
}

export interface ChatPanelTabsState {
  tabs: ChatPanelTab[];
  activeTabId: string;
}

const DEFAULT_FULLSCREEN_CHAT_PANEL_TAB_TYPES = new Set<ChatPanelTabType>([
  "work-management",
]);

export function isChatPanelTabDefaultFullscreen(
  tabOrType: ChatPanelTab | ChatPanelTabType | null | undefined
): boolean {
  const type =
    typeof tabOrType === "string" ? tabOrType : (tabOrType?.type ?? null);
  return type !== null && DEFAULT_FULLSCREEN_CHAT_PANEL_TAB_TYPES.has(type);
}

export function getWorkManagementFallbackTitle(
  section: WorkManagementSection
): string {
  switch (section) {
    case WORK_MANAGEMENT_SECTION.PROJECTS:
      return "Projects";
    case WORK_MANAGEMENT_SECTION.GITHUB_ISSUES:
      return "GitHub Issues";
    case WORK_MANAGEMENT_SECTION.GITHUB_PRS:
      return "GitHub PRs";
    case WORK_MANAGEMENT_SECTION.KANBAN:
      return "Kanban";
  }
}

export function normalizePersistedChatPanelTabsState(
  value: unknown
): ChatPanelTabsState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ChatPanelTabsState>;
  if (!Array.isArray(candidate.tabs)) return null;

  const mappedTabs = candidate.tabs
    .filter((tab) => tab.type !== "terminal")
    .map((tab) => {
      const persistedType = (tab as { type: string }).type;
      if (persistedType === "session" && !tab.sessionId) {
        return {
          ...tab,
          type: "start-page",
          title: "Launchpad",
        } as ChatPanelTab;
      }
      if (persistedType === "launchpad" || persistedType === "dashboard") {
        return {
          ...tab,
          type: "start-page",
          title: "Launchpad",
        } as ChatPanelTab;
      }
      if (persistedType === "work-management") {
        const managementSection =
          tab.managementSection ?? WORK_MANAGEMENT_SECTION.KANBAN;
        return {
          ...tab,
          title: getWorkManagementFallbackTitle(managementSection),
          managementSection,
        } as ChatPanelTab;
      }
      return tab;
    });

  const activeMappedTab = mappedTabs.find(
    (tab) => tab.id === candidate.activeTabId
  );
  const preferredWorkManagementTabIds = new Map<
    WorkManagementSection,
    string
  >();
  for (const tab of mappedTabs) {
    if (tab.type !== "work-management" || !tab.managementSection) continue;
    const preferredTabId = preferredWorkManagementTabIds.get(
      tab.managementSection
    );
    if (
      preferredTabId === undefined ||
      (activeMappedTab?.type === "work-management" &&
        activeMappedTab.id === tab.id)
    ) {
      preferredWorkManagementTabIds.set(tab.managementSection, tab.id);
    }
  }
  const preferredRuntimeTabId =
    activeMappedTab?.type === "runtime"
      ? activeMappedTab.id
      : mappedTabs.find((tab) => tab.type === "runtime")?.id;
  const preferredCloudOrgTabId =
    activeMappedTab?.type === "cloud-org"
      ? activeMappedTab.id
      : mappedTabs.find((tab) => tab.type === "cloud-org")?.id;
  // The Launchpad start page is a singleton: collapse any persisted duplicates
  // to a single tab (preferring the active one) so new-session / launchpad
  // entry points can never stack more than one.
  const preferredStartPageTabId =
    activeMappedTab?.type === "start-page"
      ? activeMappedTab.id
      : mappedTabs.find((tab) => tab.type === "start-page")?.id;
  const survivingTabs = mappedTabs.filter(
    (tab) =>
      (tab.type !== "work-management" ||
        (tab.managementSection !== undefined &&
          tab.id ===
            preferredWorkManagementTabIds.get(tab.managementSection))) &&
      (tab.type !== "runtime" || tab.id === preferredRuntimeTabId) &&
      (tab.type !== "cloud-org" || tab.id === preferredCloudOrgTabId) &&
      (tab.type !== "start-page" || tab.id === preferredStartPageTabId)
  );
  if (survivingTabs.length === 0) return null;

  const activeTabId = survivingTabs.some(
    (tab) => tab.id === candidate.activeTabId
  )
    ? (candidate.activeTabId as string)
    : survivingTabs[0].id;
  return { tabs: survivingTabs, activeTabId };
}
