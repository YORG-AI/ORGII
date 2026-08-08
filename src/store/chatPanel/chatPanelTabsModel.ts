import type { CloudChannelVisibility } from "@src/features/Org2Cloud/channels/types";
import type {
  ChatPanelSelectedCloudOrg,
  ChatPanelSelectedOrganization,
  ChatPanelSelectedProject,
  ChatPanelSelectedProjectOrg,
  ChatPanelSelectedWorkItem,
  ChatPanelSelectedWorkspace,
} from "@src/store/ui/chatPanelAtom";
import {
  WORK_MANAGEMENT_SECTION,
  type WorkManagementSection,
} from "@src/store/workstation/workstationTabBarAtoms";
import type {
  GitHubIssueDetailTabData,
  GitHubPrDetailTabData,
} from "@src/types/githubDetail";

export type ChatPanelTabType =
  | "session"
  | "terminal"
  | "start-page"
  | "runtime"
  | "team-inbox"
  | "work-management"
  | "workspace"
  | "organization"
  | "work-item"
  | "github-issue"
  | "github-pr"
  | "project"
  | "explore"
  | "channel";

/**
 * Payload for a "channel" tab, discriminated by scope. Local channels live in
 * `localChannelsAtom` (this machine, single user); cloud channels are org
 * rows from the `0014_org_channels.sql` control plane. Unlike the other tab
 * payloads this type lives here rather than in `chatPanelAtom.ts` — a channel
 * tab needs no `chatPanelSelected*Atom` replay, so it never joins the
 * navigate-command surface.
 */
export type ChatPanelSelectedChannel =
  | { scope: "local"; channelId: string; name: string }
  | {
      scope: "cloud";
      orgId: string;
      channelId: string;
      name: string;
      visibility: CloudChannelVisibility;
    };

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
   * For "organization" tabs: the cloud or local organization restored when
   * this shared management tab is activated.
   */
  organization?: ChatPanelSelectedOrganization;
  /**
   * For "work-item" tabs: the linked work item plus its project/org context.
   * Writable in place — the work-item panel edits/refreshes this payload.
   */
  workItem?: ChatPanelSelectedWorkItem;
  /** For GitHub issue tabs opened from a chat-pane Work Management parent. */
  githubIssue?: GitHubIssueDetailTabData;
  /** For GitHub PR tabs opened from a chat-pane Work Management parent. */
  githubPr?: GitHubPrDetailTabData;
  /**
   * For "project" tabs: the linked project plus its slug/org context. The
   * panel self-fetches the project's work items from `project.projectSlug`.
   */
  project?: ChatPanelSelectedProject;
  /**
   * For "channel" tabs: the local or cloud channel whose message surface this
   * pill owns. The surface renders straight from this payload.
   */
  channel?: ChatPanelSelectedChannel;
}

export interface ChatPanelTabsState {
  tabs: ChatPanelTab[];
  activeTabId: string;
}

/** Fixed id of the shared cloud/local organization management tab. */
export const ORGANIZATION_TAB_ID = "chat-organization-management";

type ChatPanelTabStationAccess = "always" | "wide-only";

/**
 * Minimum viewport width at which standalone Chat Panel surfaces may share
 * the workbench with a Station pane.
 */
export const CHAT_PANEL_STATION_WIDE_VIEWPORT_MIN_PX = 1920;

/**
 * When a Chat Panel tab can share the workbench with a Station surface.
 *
 * This record is intentionally exhaustive: a new tab type must make an
 * explicit layout decision instead of silently inheriting an unsafe default.
 * Conversation-oriented tabs can always remain docked beside the Station;
 * standalone management and detail surfaces unlock the split layout only on
 * a wide desktop viewport.
 */
const CHAT_PANEL_TAB_STATION_ACCESS: Record<
  ChatPanelTabType,
  ChatPanelTabStationAccess
> = {
  session: "always",
  terminal: "always",
  "start-page": "always",
  channel: "always",
  runtime: "wide-only",
  "team-inbox": "wide-only",
  "work-management": "wide-only",
  workspace: "wide-only",
  organization: "wide-only",
  "work-item": "wide-only",
  "github-issue": "wide-only",
  "github-pr": "wide-only",
  project: "wide-only",
  explore: "wide-only",
};

/**
 * Tab types safe to restore from persisted state. Terminals are process-bound,
 * and unknown/retired surface types are discarded after legacy migrations.
 */
const PERSISTED_CHAT_PANEL_TAB_TYPES = new Set<ChatPanelTabType>([
  "session",
  "start-page",
  "runtime",
  "team-inbox",
  "work-management",
  "workspace",
  "organization",
  "work-item",
  "github-issue",
  "github-pr",
  "project",
  "explore",
  "channel",
]);

export function isChatPanelTabStationAvailable(
  tabOrType: ChatPanelTab | ChatPanelTabType | null | undefined,
  viewportWidth: number | undefined
): boolean {
  const type =
    typeof tabOrType === "string" ? tabOrType : (tabOrType?.type ?? null);
  if (type === null) return true;
  const access = CHAT_PANEL_TAB_STATION_ACCESS[type];
  return (
    access === "always" ||
    (viewportWidth !== undefined &&
      viewportWidth >= CHAT_PANEL_STATION_WIDE_VIEWPORT_MIN_PX)
  );
}

/** Resolve the layout without mutating the user's persisted maximize choice. */
export function resolveChatPanelMaximizedForLayout(
  userMaximized: boolean,
  tabOrType: ChatPanelTab | ChatPanelTabType | null | undefined,
  viewportWidth: number | undefined
): boolean {
  return (
    userMaximized || !isChatPanelTabStationAvailable(tabOrType, viewportWidth)
  );
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
    case WORK_MANAGEMENT_SECTION.RUNS:
      return "Runs";
    case WORK_MANAGEMENT_SECTION.KANBAN:
      return "Kanban";
  }
}

export function isWorkManagementListSection(
  section: WorkManagementSection
): boolean {
  return section !== WORK_MANAGEMENT_SECTION.KANBAN;
}

export function normalizePersistedChatPanelTabsState(
  value: unknown
): ChatPanelTabsState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ChatPanelTabsState>;
  if (!Array.isArray(candidate.tabs)) return null;

  const mappedTabs = candidate.tabs
    .map((tab) => {
      const persistedType = (tab as { type: string }).type;
      const legacyTab = tab as ChatPanelTab & {
        cloudOrg?: ChatPanelSelectedCloudOrg;
        projectOrg?: ChatPanelSelectedProjectOrg;
      };
      if (persistedType === "cloud-org" && legacyTab.cloudOrg) {
        return {
          ...tab,
          type: "organization",
          organization: { kind: "cloud", cloudOrg: legacyTab.cloudOrg },
          cloudOrg: undefined,
        } as ChatPanelTab;
      }
      if (persistedType === "project-org" && legacyTab.projectOrg) {
        return {
          ...tab,
          type: "organization",
          organization: { kind: "local", projectOrg: legacyTab.projectOrg },
          projectOrg: undefined,
        } as ChatPanelTab;
      }
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
    })
    .filter((tab) => PERSISTED_CHAT_PANEL_TAB_TYPES.has(tab.type));

  const activeMappedTab = mappedTabs.find(
    (tab) => tab.id === candidate.activeTabId
  );
  const preferredWorkManagementTabIds = new Map<"kanban" | "work", string>();
  for (const tab of mappedTabs) {
    if (tab.type !== "work-management" || !tab.managementSection) continue;
    const tabGroup = isWorkManagementListSection(tab.managementSection)
      ? "work"
      : "kanban";
    const preferredTabId = preferredWorkManagementTabIds.get(tabGroup);
    if (
      preferredTabId === undefined ||
      (activeMappedTab?.type === "work-management" &&
        activeMappedTab.id === tab.id)
    ) {
      preferredWorkManagementTabIds.set(tabGroup, tab.id);
    }
  }
  const preferredRuntimeTabId =
    activeMappedTab?.type === "runtime"
      ? activeMappedTab.id
      : mappedTabs.find((tab) => tab.type === "runtime")?.id;
  const preferredTeamInboxTabId =
    activeMappedTab?.type === "team-inbox"
      ? activeMappedTab.id
      : mappedTabs.find((tab) => tab.type === "team-inbox")?.id;
  const preferredOrganizationTab =
    activeMappedTab?.type === "organization"
      ? activeMappedTab
      : mappedTabs.find((tab) => tab.type === "organization");
  // The Launchpad start page is a singleton: collapse any persisted duplicates
  // to a single tab (preferring the active one) so new-session / launchpad
  // entry points can never stack more than one.
  const preferredStartPageTabId =
    activeMappedTab?.type === "start-page"
      ? activeMappedTab.id
      : mappedTabs.find((tab) => tab.type === "start-page")?.id;
  const survivingTabs = mappedTabs
    .filter(
      (tab) =>
        (tab.type !== "work-management" ||
          (tab.managementSection !== undefined &&
            tab.id ===
              preferredWorkManagementTabIds.get(
                isWorkManagementListSection(tab.managementSection)
                  ? "work"
                  : "kanban"
              ))) &&
        (tab.type !== "runtime" || tab.id === preferredRuntimeTabId) &&
        (tab.type !== "team-inbox" || tab.id === preferredTeamInboxTabId) &&
        (tab.type !== "organization" || tab === preferredOrganizationTab) &&
        (tab.type !== "start-page" || tab.id === preferredStartPageTabId)
    )
    .map((tab) =>
      tab.type === "organization" ? { ...tab, id: ORGANIZATION_TAB_ID } : tab
    );
  if (survivingTabs.length === 0) return null;

  const activeTabId =
    preferredOrganizationTab !== undefined &&
    activeMappedTab === preferredOrganizationTab
      ? ORGANIZATION_TAB_ID
      : survivingTabs.some((tab) => tab.id === candidate.activeTabId)
        ? (candidate.activeTabId as string)
        : survivingTabs[0].id;
  return { tabs: survivingTabs, activeTabId };
}
