/**
 * Chat Panel Tab Store
 *
 * Multi-tab state for the chat panel. Each tab is one of:
 *   "session"  — AI agent session chat history
 *   "terminal" — Live PTY terminal embedded in the chat pane
 *   "start-page" — Launchpad with Work / Manage / Trend tabs
 *   "work-management" — Singleton management surface with internal sections
 *   "workspace" — A workspace's overview / detail page (one pill per workspace)
 *   "cloud-org" — Singleton managed-cloud organization settings page
 *
 * Terminal tabs share the global terminal atom store but use session IDs
 * prefixed with "chatpanel-" so they are invisible to the Workstation
 * terminal manager.
 *
 * Performance contract:
 *   - `atomWithStorage` with a debounced write avoids blocking the UI on
 *     every tab switch. The 400 ms debounce matches the pattern used by
 *     chatWidthAtom and workstationLayoutAtom.
 *   - Tab content is lazy-rendered: only the active tab mounts heavyweight
 *     components (TerminalCore, ChatView). Inactive tabs keep their atoms
 *     alive but their React trees are hidden (not unmounted) via CSS so that
 *     PTY processes stay connected and chat history is not lost.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { destroyChatPanelTerminalAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import {
  activeSessionIdAtom,
  jumpToSessionAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import {
  CHAT_PANEL_START_PAGE_TAB,
  CHAT_PANEL_SURFACE_KIND,
  type ChatPanelSelectedCloudOrg,
  type ChatPanelSelectedWorkspace,
  type ChatPanelStartPageTab,
  type WorkspaceOverviewTab,
  chatPanelMaximizedAtom,
  chatPanelNavigateAtom,
  chatPanelSelectedCloudOrgAtom,
  chatPanelStartPageOpenAtom,
  chatPanelStartPageTabAtom,
  chatPanelWorkspaceOverviewTabAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  WORK_MANAGEMENT_SECTION,
  type WorkManagementSection,
} from "@src/store/workstation/workstationTabBarAtoms";

import { disposeWorkManagementStateAtom } from "./disposeWorkManagementStateAtom";

function getWorkManagementFallbackTitle(
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

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type ChatPanelTabType =
  | "session"
  | "terminal"
  | "start-page"
  | "work-management"
  | "workspace"
  | "cloud-org";

export interface ChatPanelTab {
  id: string;
  type: ChatPanelTabType;
  /** Display label */
  title: string;
  /** Active inner section for the singleton Kanban tab. */
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
}

const DEFAULT_FULLSCREEN_CHAT_PANEL_TAB_TYPES = new Set<ChatPanelTabType>([
  "work-management",
]);

function isChatPanelTabDefaultFullscreen(
  tabOrType: ChatPanelTab | ChatPanelTabType | null | undefined
): boolean {
  const type =
    typeof tabOrType === "string" ? tabOrType : (tabOrType?.type ?? null);
  return type !== null && DEFAULT_FULLSCREEN_CHAT_PANEL_TAB_TYPES.has(type);
}

export interface ChatPanelTabsState {
  tabs: ChatPanelTab[];
  activeTabId: string;
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
  const preferredWorkManagementTabId =
    activeMappedTab?.type === "work-management"
      ? activeMappedTab.id
      : mappedTabs.find((tab) => tab.type === "work-management")?.id;
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
        tab.id === preferredWorkManagementTabId) &&
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

// ────────────────────────────────────────────────────────────────────────────
// Debounced storage (400 ms, matching other high-frequency panel atoms)
// ────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "orgii:chatPanelTabs:v2";
const WRITE_DEBOUNCE_MS = 400;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

const debouncedStorage = {
  getItem(key: string): ChatPanelTabsState {
    // On app restart, close all chat-pane tabs: never rehydrate persisted
    // tabs, always start from a fresh single Launchpad tab. The persisted
    // value is cleared so it can't leak back in through any other reader.
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore removal errors
    }
    return buildInitialState();
  },
  setItem(key: string, value: ChatPanelTabsState): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Ignore write errors
      }
    }, WRITE_DEBOUNCE_MS);
  },
  removeItem(key: string): void {
    localStorage.removeItem(key);
  },
  subscribe(
    _key: string,
    _callback: (value: ChatPanelTabsState) => void
  ): () => void {
    return () => undefined;
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Initial state factory
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_LAUNCHPAD_TAB_ID = "launchpad-default";

function buildDefaultLaunchpadTab(): ChatPanelTab {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_LAUNCHPAD_TAB_ID,
    type: "start-page",
    title: "Launchpad",
    createdAt: now,
    updatedAt: now,
  };
}

function buildInitialState(): ChatPanelTabsState {
  const launchpad = buildDefaultLaunchpadTab();
  return {
    tabs: [launchpad],
    activeTabId: launchpad.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Core atom
// ────────────────────────────────────────────────────────────────────────────

export const chatPanelTabsAtom = atomWithStorage<ChatPanelTabsState>(
  STORAGE_KEY,
  buildInitialState(),
  debouncedStorage
);
chatPanelTabsAtom.debugLabel = "chatPanelTabs";

// ────────────────────────────────────────────────────────────────────────────
// Derived read atoms
// ────────────────────────────────────────────────────────────────────────────

export const activeChatPanelTabAtom = atom((get) => {
  const state = get(chatPanelTabsAtom);
  return (
    state.tabs.find((tab) => tab.id === state.activeTabId) ??
    state.tabs[0] ??
    null
  );
});
activeChatPanelTabAtom.debugLabel = "activeChatPanelTab";

/**
 * Kanban content and sidebar selection are projections of the active
 * ChatPanel tab. Keeping this derived prevents tab chrome, content, and
 * sidebar state from drifting independently.
 */
export const activeWorkManagementSectionAtom = atom(
  (get) =>
    get(activeChatPanelTabAtom)?.managementSection ??
    WORK_MANAGEMENT_SECTION.KANBAN
);
activeWorkManagementSectionAtom.debugLabel = "activeWorkManagementSection";

export const chatPanelTabCountAtom = atom(
  (get) => get(chatPanelTabsAtom).tabs.length
);

/** Maximize-state snapshot taken before entering a default-fullscreen tab. */
const defaultFullscreenTabPriorMaximizedAtom = atom<boolean | null>(null);

const transitionChatPanelTabPresentationAtom = atom(
  null,
  (
    get,
    set,
    {
      previousTab,
      nextTab,
    }: {
      previousTab: ChatPanelTab | null | undefined;
      nextTab: ChatPanelTab | null | undefined;
    }
  ) => {
    const previousDefaultFullscreen =
      isChatPanelTabDefaultFullscreen(previousTab);
    const nextDefaultFullscreen = isChatPanelTabDefaultFullscreen(nextTab);

    if (nextDefaultFullscreen) {
      if (!previousDefaultFullscreen) {
        set(
          defaultFullscreenTabPriorMaximizedAtom,
          get(chatPanelMaximizedAtom)
        );
      }
      if (!get(chatPanelMaximizedAtom)) {
        set(chatPanelMaximizedAtom, true);
      }
      return;
    }

    if (previousDefaultFullscreen) {
      const priorMaximized = get(defaultFullscreenTabPriorMaximizedAtom);
      // A manual Workstation restore while Kanban is active is an
      // explicit override. Preserve it instead of restoring an older
      // maximized state when the user later changes tabs.
      if (get(chatPanelMaximizedAtom) && priorMaximized !== null) {
        set(chatPanelMaximizedAtom, priorMaximized);
      }
      set(defaultFullscreenTabPriorMaximizedAtom, null);
    }
  }
);

/** Make the active tab's legacy surface atoms match its canonical identity. */
const syncChatPanelTabNavigationAtom = atom(
  null,
  (_get, set, tab: ChatPanelTab | null | undefined) => {
    if (!tab) return;

    if (tab.type === "start-page") {
      set(chatPanelNavigateAtom, { kind: CHAT_PANEL_SURFACE_KIND.SESSION });
      set(chatPanelStartPageOpenAtom, true);
      set(jumpToSessionAtom, null);
      return;
    }

    if (tab.type === "workspace" && tab.workspace) {
      // A workspace tab owns the workspace-overview surface. Re-navigating on
      // activation repopulates the selected-workspace atom the surface reads,
      // so switching back to this pill restores its detail page. Passing no
      // `tab` preserves whichever overview sub-tab is currently showing.
      set(chatPanelNavigateAtom, {
        kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW,
        workspace: tab.workspace,
      });
      set(jumpToSessionAtom, null);
      return;
    }

    if (tab.type === "cloud-org" && tab.cloudOrg) {
      set(chatPanelNavigateAtom, {
        kind: CHAT_PANEL_SURFACE_KIND.CLOUD_ORG,
        cloudOrg: tab.cloudOrg,
      });
      set(jumpToSessionAtom, null);
      return;
    }

    set(chatPanelStartPageOpenAtom, false);

    // Session is the neutral legacy surface underneath tabs whose content is
    // owned by ChatPanelShell (management and terminal tabs).
    set(chatPanelNavigateAtom, { kind: CHAT_PANEL_SURFACE_KIND.SESSION });
    if (tab.type !== "session") set(jumpToSessionAtom, null);
  }
);

/**
 * Reconcile legacy surface state after hydration or layout changes.
 * Presentation defaults are applied only on tab entry so a manual Workstation
 * restore is not overwritten while Kanban remains active.
 */
export const syncActiveChatPanelTabStateAtom = atom(null, (get, set) => {
  const state = get(chatPanelTabsAtom);
  const activeTab =
    state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  // A start-page tab is also the host for non-session project surfaces.
  // Navigation deliberately closes the Launchpad before selecting one of
  // those surfaces. Do not let the React reconciliation pass erase that
  // newer navigation command after a switch away from Work Management.
  if (activeTab?.type !== "start-page" || get(chatPanelStartPageOpenAtom)) {
    set(syncChatPanelTabNavigationAtom, activeTab);
  }

  if (
    isChatPanelTabDefaultFullscreen(activeTab) &&
    get(defaultFullscreenTabPriorMaximizedAtom) === null
  ) {
    set(defaultFullscreenTabPriorMaximizedAtom, get(chatPanelMaximizedAtom));
  }
});
syncActiveChatPanelTabStateAtom.debugLabel = "syncActiveChatPanelTabState";

// ────────────────────────────────────────────────────────────────────────────
// Write-only action atoms
// ────────────────────────────────────────────────────────────────────────────

interface ActivateChatPanelTabOptions {
  tabId: string;
  sessionName?: string;
  repoPath?: string;
}

function getActivateTabOptions(
  optionsOrTabId: ActivateChatPanelTabOptions | string
): ActivateChatPanelTabOptions {
  return typeof optionsOrTabId === "string"
    ? { tabId: optionsOrTabId }
    : optionsOrTabId;
}

/** Switch to a tab by ID and sync session state for linked session tabs. */
export const activateChatPanelTabAtom = atom(
  null,
  (get, set, optionsOrTabId: ActivateChatPanelTabOptions | string) => {
    const { tabId, sessionName, repoPath } =
      getActivateTabOptions(optionsOrTabId);
    const state = get(chatPanelTabsAtom);
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const previousTab =
      state.tabs.find((candidate) => candidate.id === state.activeTabId) ??
      null;

    if (state.activeTabId !== tabId) {
      set(chatPanelTabsAtom, { ...state, activeTabId: tabId });
    }
    set(transitionChatPanelTabPresentationAtom, {
      previousTab,
      nextTab: tab,
    });

    set(syncChatPanelTabNavigationAtom, tab);

    if (tab.type === "start-page") {
      return;
    }

    if (
      tab.type === "terminal" ||
      tab.type === "work-management" ||
      tab.type === "workspace" ||
      tab.type === "cloud-org"
    ) {
      // Surface state for these tabs is fully driven by
      // `syncChatPanelTabNavigationAtom` above; there is no session to jump to.
      return;
    }

    const sessionId = tab.type === "session" ? tab.sessionId : null;
    if (
      sessionId &&
      (get(workstationActiveSessionIdAtom) !== sessionId ||
        get(activeSessionIdAtom) !== sessionId)
    ) {
      const session = get(sessionByIdAtom(sessionId));
      set(jumpToSessionAtom, {
        sessionId,
        sessionName: sessionName ?? session?.name,
        repoPath: repoPath ?? session?.repoPath,
      });
    }
  }
);
activateChatPanelTabAtom.debugLabel = "activateChatPanelTab";

interface AppendAndActivateChatPanelTabOptions {
  tab: ChatPanelTab;
  sessionName?: string;
  repoPath?: string;
}

/** Append a tab and run the same presentation/navigation activation chain. */
const appendAndActivateChatPanelTabAtom = atom(
  null,
  (
    get,
    set,
    { tab, sessionName, repoPath }: AppendAndActivateChatPanelTabOptions
  ) => {
    const state = get(chatPanelTabsAtom);
    const previousTab =
      state.tabs.find((candidate) => candidate.id === state.activeTabId) ??
      null;

    set(transitionChatPanelTabPresentationAtom, {
      previousTab,
      nextTab: tab,
    });
    set(chatPanelTabsAtom, {
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    });
    set(activateChatPanelTabAtom, {
      tabId: tab.id,
      sessionName,
      repoPath,
    });
  }
);

/** Add a standalone Launchpad tab and show its Work / Manage / Trend page. */
export const addChatPanelLaunchpadTabAtom = atom(
  null,
  (_get, set, title: string = "Launchpad") => {
    const id = `launchpad-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    set(appendAndActivateChatPanelTabAtom, {
      tab: {
        id,
        type: "start-page",
        title,
        createdAt: now,
        updatedAt: now,
      },
    });
    return id;
  }
);
addChatPanelLaunchpadTabAtom.debugLabel = "addChatPanelLaunchpadTab";

interface OpenOrFocusStartPageTabOptions {
  section?: ChatPanelStartPageTab;
  title?: string;
}

/**
 * Focus the singleton Launchpad start-page tab at the requested section, or
 * create it when none is open. This is the one entry point new-session and
 * launchpad triggers should use so they reuse the existing tab instead of
 * stacking duplicates.
 */
export const openOrFocusChatPanelStartPageTabAtom = atom(
  null,
  (get, set, options: OpenOrFocusStartPageTabOptions = {}) => {
    const { section = CHAT_PANEL_START_PAGE_TAB.WORK, title = "Launchpad" } =
      options;
    set(chatPanelStartPageTabAtom, section);
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "start-page"
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    return set(addChatPanelLaunchpadTabAtom, title);
  }
);
openOrFocusChatPanelStartPageTabAtom.debugLabel =
  "openOrFocusChatPanelStartPageTab";

/** Focus the existing Launchpad at Manage, or create it when none is open. */
export const openOrFocusChatPanelManageTabAtom = atom(null, (_get, set) =>
  set(openOrFocusChatPanelStartPageTabAtom, {
    section: CHAT_PANEL_START_PAGE_TAB.MANAGE,
  })
);
openOrFocusChatPanelManageTabAtom.debugLabel = "openOrFocusChatPanelManageTab";

interface OpenKanbanTabOptions {
  section?: WorkManagementSection;
  title?: string;
}

/** Open or focus the singleton Kanban tab at the requested section. */
export const openKanbanChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenKanbanTabOptions = {}) => {
    const {
      section = WORK_MANAGEMENT_SECTION.KANBAN,
      title = getWorkManagementFallbackTitle(section),
    } = options;
    const state = get(chatPanelTabsAtom);
    const existingTab = state.tabs.find(
      (tab) => tab.type === "work-management"
    );
    if (existingTab) {
      set(chatPanelTabsAtom, {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === existingTab.id
            ? { ...tab, title, managementSection: section }
            : tab
        ),
      });
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const id = "chat-work-management";
    const now = new Date().toISOString();
    const tab: ChatPanelTab = {
      id,
      type: "work-management",
      title,
      managementSection: section,
      createdAt: now,
      updatedAt: now,
    };
    set(appendAndActivateChatPanelTabAtom, { tab });
    return id;
  }
);
openKanbanChatPanelTabAtom.debugLabel = "openKanbanChatPanelTab";

interface OpenWorkspaceOverviewTabOptions {
  workspace: ChatPanelSelectedWorkspace;
  /** Overview sub-tab to land on (e.g. Details). Preserves current when omitted. */
  tab?: WorkspaceOverviewTab;
}

/**
 * Open — or focus, if already open — a dedicated chat-panel tab for a
 * workspace's overview / detail page. Each workspace gets its own pill titled
 * with the workspace name (not "Launchpad"); re-opening the same workspace
 * focuses the existing tab instead of stacking duplicates. The active tab
 * drives `chatPanelSelectedWorkspaceAtom` through `chatPanelNavigateAtom`,
 * which is what the overview surface actually renders from.
 */
export const openWorkspaceOverviewInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenWorkspaceOverviewTabOptions) => {
    const { workspace, tab: overviewTab } = options;
    // Seed the requested sub-tab before activation: the navigate that runs on
    // activation passes no explicit tab, so it preserves this value.
    if (overviewTab) {
      set(chatPanelWorkspaceOverviewTabAtom, overviewTab);
    }

    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (candidate) =>
        candidate.type === "workspace" &&
        candidate.workspace?.kind === workspace.kind &&
        candidate.workspace?.id === workspace.id
    );
    if (existingTab) {
      // Refresh the stored payload (name/path can drift) before focusing.
      set(chatPanelTabsAtom, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((candidate) =>
          candidate.id === existingTab.id
            ? { ...candidate, title: workspace.name, workspace }
            : candidate
        ),
      }));
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const id = `workspace-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    set(appendAndActivateChatPanelTabAtom, {
      tab: {
        id,
        type: "workspace",
        title: workspace.name,
        workspace,
        createdAt: now,
        updatedAt: now,
      },
    });
    return id;
  }
);
openWorkspaceOverviewInChatPanelTabAtom.debugLabel =
  "openWorkspaceOverviewInChatPanelTab";

interface OpenCloudOrgManagementTabOptions {
  cloudOrg: ChatPanelSelectedCloudOrg;
  title?: string;
}

/**
 * Open or focus the singleton managed-cloud organization settings tab.
 * Switching organizations updates the tab payload in place, so its identity
 * remains "Manage ORG" and activating it restores the selected organization.
 */
export const openCloudOrgManagementInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenCloudOrgManagementTabOptions) => {
    const { cloudOrg, title = "Manage ORG" } = options;
    const state = get(chatPanelTabsAtom);
    const existingTab = state.tabs.find((tab) => tab.type === "cloud-org");
    if (existingTab) {
      set(chatPanelTabsAtom, {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === existingTab.id ? { ...tab, title, cloudOrg } : tab
        ),
      });
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const id = "chat-cloud-org-management";
    const now = new Date().toISOString();
    set(appendAndActivateChatPanelTabAtom, {
      tab: {
        id,
        type: "cloud-org",
        title,
        cloudOrg,
        createdAt: now,
        updatedAt: now,
      },
    });
    return id;
  }
);
openCloudOrgManagementInChatPanelTabAtom.debugLabel =
  "openCloudOrgManagementInChatPanelTab";

interface OpenSessionInNewChatTabOptions {
  sessionId: string;
  sessionName?: string;
  repoPath?: string;
}

/**
 * Open an existing session in a new chat panel tab and make it the active
 * WorkStation session.
 */
export const openSessionInNewChatTabAtom = atom(
  null,
  (_get, set, optionsOrSessionId: OpenSessionInNewChatTabOptions | string) => {
    const options =
      typeof optionsOrSessionId === "string"
        ? { sessionId: optionsOrSessionId }
        : optionsOrSessionId;
    const { sessionId, sessionName, repoPath } = options;
    const id = `chat-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    set(appendAndActivateChatPanelTabAtom, {
      tab: {
        id,
        type: "session",
        title: sessionName ?? "Chat",
        createdAt: now,
        updatedAt: now,
        sessionId,
      },
      sessionName,
      repoPath,
    });
    return id;
  }
);
openSessionInNewChatTabAtom.debugLabel = "openSessionInNewChatTab";

/** Focus an existing tab for a session, or create one when none is open. */
export const openOrFocusSessionInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenSessionInNewChatTabOptions) => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "session" && tab.sessionId === options.sessionId
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, {
        tabId: existingTab.id,
        sessionName: options.sessionName,
        repoPath: options.repoPath,
      });
      return existingTab.id;
    }

    return set(openSessionInNewChatTabAtom, options);
  }
);
openOrFocusSessionInChatPanelTabAtom.debugLabel =
  "openOrFocusSessionInChatPanelTab";

/**
 * Open a session from the sidebar without stacking tabs during normal
 * navigation. An already-open target is focused; otherwise the active session
 * tab is repointed to the target. Non-session tabs are never replaced.
 */
export const openOrReplaceSessionInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenSessionInNewChatTabOptions) => {
    const state = get(chatPanelTabsAtom);
    const existingTab = state.tabs.find(
      (tab) => tab.type === "session" && tab.sessionId === options.sessionId
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, {
        tabId: existingTab.id,
        sessionName: options.sessionName,
        repoPath: options.repoPath,
      });
      return existingTab.id;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (activeTab?.type !== "session") {
      return set(openSessionInNewChatTabAtom, options);
    }

    const session = get(sessionByIdAtom(options.sessionId));
    const replacementTab: ChatPanelTab = {
      ...activeTab,
      title: options.sessionName ?? session?.name ?? "Chat",
      sessionId: options.sessionId,
      updatedAt: new Date().toISOString(),
    };
    set(chatPanelTabsAtom, {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === activeTab.id ? replacementTab : tab
      ),
    });
    set(activateChatPanelTabAtom, {
      tabId: activeTab.id,
      sessionName: options.sessionName,
      repoPath: options.repoPath,
    });
    return activeTab.id;
  }
);
openOrReplaceSessionInChatPanelTabAtom.debugLabel =
  "openOrReplaceSessionInChatPanelTab";

interface AddTerminalTabOptions {
  terminalSessionId: string;
  title?: string;
  /** CLI binary command to write to the PTY once the shell is ready (e.g. "claude") */
  cliCommand?: string;
}

/** Add a new terminal tab, using the provided terminal session ID */
export const addChatPanelTerminalTabAtom = atom(
  null,
  (_get, set, optionsOrId: AddTerminalTabOptions | string) => {
    const {
      terminalSessionId,
      title = "Terminal",
      cliCommand,
    } = typeof optionsOrId === "string"
      ? { terminalSessionId: optionsOrId }
      : optionsOrId;
    const id = `terminal-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    set(appendAndActivateChatPanelTabAtom, {
      tab: {
        id,
        type: "terminal",
        title,
        createdAt: now,
        updatedAt: now,
        terminalSessionId,
        cliCommand,
      },
    });
    return id;
  }
);
addChatPanelTerminalTabAtom.debugLabel = "addChatPanelTerminalTab";

/** Clear the cliCommand on a tab after it has been injected */
export const clearChatPanelTabCliCommandAtom = atom(
  null,
  (_get, set, tabId: string) => {
    set(chatPanelTabsAtom, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, cliCommand: undefined } : tab
      ),
    }));
  }
);
clearChatPanelTabCliCommandAtom.debugLabel = "clearChatPanelTabCliCommand";

/** Close a tab by ID. If it was active, move to the nearest neighbour. */
export const closeChatPanelTabAtom = atom(null, (get, set, tabId: string) => {
  const state = get(chatPanelTabsAtom);
  const idx = state.tabs.findIndex((tab) => tab.id === tabId);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  if (tab.type === "work-management") {
    set(disposeWorkManagementStateAtom);
  }
  const nextTabs = state.tabs.filter((candidate) => candidate.id !== tabId);
  let nextActiveId = state.activeTabId;

  if (nextTabs.length === 0) {
    const launchpad = buildDefaultLaunchpadTab();
    set(transitionChatPanelTabPresentationAtom, {
      previousTab: tab,
      nextTab: launchpad,
    });
    set(chatPanelTabsAtom, {
      tabs: [launchpad],
      activeTabId: launchpad.id,
    });
    set(activateChatPanelTabAtom, launchpad.id);
    return;
  }

  if (state.activeTabId === tabId) {
    const nextIdx = Math.max(0, idx - 1);
    nextActiveId = nextTabs[Math.min(nextIdx, nextTabs.length - 1)].id;
    set(transitionChatPanelTabPresentationAtom, {
      previousTab: tab,
      nextTab: nextTabs.find((candidate) => candidate.id === nextActiveId),
    });
  }

  set(chatPanelTabsAtom, { tabs: nextTabs, activeTabId: nextActiveId });
  if (state.activeTabId === tabId) {
    set(activateChatPanelTabAtom, nextActiveId);
  }
});
closeChatPanelTabAtom.debugLabel = "closeChatPanelTab";

/** Close the singleton org-management tab, or clear a legacy bare surface. */
export const closeCloudOrgManagementChatPanelTabAtom = atom(
  null,
  (get, set) => {
    const tab = get(chatPanelTabsAtom).tabs.find(
      (candidate) => candidate.type === "cloud-org"
    );
    if (tab) {
      set(closeChatPanelTabAtom, tab.id);
      return;
    }
    set(chatPanelSelectedCloudOrgAtom, null);
  }
);
closeCloudOrgManagementChatPanelTabAtom.debugLabel =
  "closeCloudOrgManagementChatPanelTab";

/** Navigate to the next tab (wraps around) */
export const nextChatPanelTabAtom = atom(null, (get, set) => {
  const state = get(chatPanelTabsAtom);
  if (state.tabs.length === 0) return;
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const nextIdx = ((idx === -1 ? 0 : idx) + 1) % state.tabs.length;
  set(activateChatPanelTabAtom, state.tabs[nextIdx].id);
});
nextChatPanelTabAtom.debugLabel = "nextChatPanelTab";

/** Navigate to the previous tab (wraps around) */
export const prevChatPanelTabAtom = atom(null, (get, set) => {
  const state = get(chatPanelTabsAtom);
  if (state.tabs.length === 0) return;
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const currentIdx = idx === -1 ? 0 : idx;
  const prevIdx = (currentIdx - 1 + state.tabs.length) % state.tabs.length;
  set(activateChatPanelTabAtom, state.tabs[prevIdx].id);
});
prevChatPanelTabAtom.debugLabel = "prevChatPanelTab";

/** Update the session ID on the given tab (called after session launch) */
export const setChatPanelTabSessionIdAtom = atom(
  null,
  (
    _get,
    set,
    { tabId, sessionId }: { tabId: string; sessionId: string | null }
  ) => {
    set(chatPanelTabsAtom, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, sessionId } : tab
      ),
    }));
  }
);

/** Update the title on the given tab */
export const setChatPanelTabTitleAtom = atom(
  null,
  (_get, set, { tabId, title }: { tabId: string; title: string }) => {
    const now = new Date().toISOString();
    set(chatPanelTabsAtom, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, title, updatedAt: now } : tab
      ),
    }));
  }
);

/** Toggle TUI mode on the given tab */
export const toggleChatPanelTabTuiModeAtom = atom(
  null,
  (_get, set, tabId: string) => {
    set(chatPanelTabsAtom, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, tuiMode: !tab.tuiMode } : tab
      ),
    }));
  }
);

/**
 * Close a tab AND, for terminal tabs, destroy the backing PTY and clear its
 * buffer cache slot. Use this instead of closeChatPanelTabAtom when the
 * caller has access to the Jotai store (i.e., inside React components).
 */
export const closeAndDestroyChatPanelTabAtom = atom(
  null,
  async (get, set, tabId: string): Promise<void> => {
    const state = get(chatPanelTabsAtom);
    const tab = state.tabs.find((t) => t.id === tabId);
    // Destroy PTY before removing the tab so the terminal session ID is still
    // reachable during cleanup.
    if (tab?.type === "terminal" && tab.terminalSessionId) {
      await set(destroyChatPanelTerminalAtom, tab.terminalSessionId);
    }
    set(closeChatPanelTabAtom, tabId);
  }
);
closeAndDestroyChatPanelTabAtom.debugLabel = "closeAndDestroyChatPanelTab";
