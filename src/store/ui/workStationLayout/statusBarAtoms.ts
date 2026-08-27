import { atom } from "jotai";

import type { StatusBarAppType } from "@src/types/ui/workstation";

export type { StatusBarAppType } from "@src/types/ui/workstation";

export interface GlobalCursorPosition {
  line: number;
  column: number;
  selectedChars?: number;
  selectedLines?: number;
}

export interface GlobalCommitInfo {
  message: string;
  author: string;
  time: string;
  shortSha: string;
}

export interface GlobalStatusBarState {
  appType: StatusBarAppType;
  cursor: GlobalCursorPosition | null;
  filePath: string | null;
  totalLines: number | undefined;
  commitInfo: GlobalCommitInfo | null;
  browserUrl: string | undefined;
  browserIsLoading: boolean | undefined;
  browserErrorCount: number | undefined;
  browserWarningCount: number | undefined;
  browserIsDevToolsOpen: boolean | undefined;
  browserIsPrivate: boolean | undefined;
  browserSessionCount: number | undefined;
  browserCurrentSessionIndex: number | undefined;
  /** True while an element is selected via the inspector. */
  browserHasSelectedElement: boolean | undefined;
  /** Short label for the selected element (e.g. "div.hp_trivia_outer"). */
  browserSelectedElementLabel: string | undefined;
  projectName: string | undefined;
  projectActiveMemberCount: number | undefined;
  projectTotalMemberCount: number | undefined;
  projectWorkItemCount: number | undefined;
  projectOrgId: string | undefined;
  projectOrgName: string | undefined;
  projectOrgGitFolderSyncEnabled: boolean | undefined;
  /**
   * Slug of the currently active project. The project status bar uses this to
   * look up live sync events in `projectSyncStatusAtom`.
   * Cleared whenever the active tab type leaves `project-workitems`.
   */
  projectSlug: string | undefined;
}

const defaultStatusBarState: GlobalStatusBarState = {
  appType: "code",
  cursor: null,
  filePath: null,
  totalLines: undefined,
  commitInfo: null,
  browserUrl: undefined,
  browserIsLoading: undefined,
  browserErrorCount: undefined,
  browserWarningCount: undefined,
  browserIsDevToolsOpen: undefined,
  browserIsPrivate: undefined,
  browserSessionCount: undefined,
  browserCurrentSessionIndex: undefined,
  browserHasSelectedElement: undefined,
  browserSelectedElementLabel: undefined,
  projectName: undefined,
  projectActiveMemberCount: undefined,
  projectTotalMemberCount: undefined,
  projectWorkItemCount: undefined,
  projectOrgId: undefined,
  projectOrgName: undefined,
  projectOrgGitFolderSyncEnabled: undefined,
  projectSlug: undefined,
};

// ============================================
// Per-App Status Bar State
// ============================================

/**
 * Per-app status bar state map.
 * Each app writes to its own slot so switching apps shows the correct bar instantly.
 */
export const perAppStatusBarStateAtom = atom<
  Record<StatusBarAppType, GlobalStatusBarState>
>({
  code: { ...defaultStatusBarState, appType: "code" },
  data: { ...defaultStatusBarState, appType: "data" },
  browser: { ...defaultStatusBarState, appType: "browser" },
  project: { ...defaultStatusBarState, appType: "project" },
});
perAppStatusBarStateAtom.debugLabel = "perAppStatusBarState";

/** Which app is currently active (set by AppShell on mode switch) */
export const activeStatusBarAppAtom = atom<StatusBarAppType>("code");
activeStatusBarAppAtom.debugLabel = "activeStatusBarApp";

/**
 * Derived read-only atom: returns the status bar state for the currently active app.
 * StatusBarRenderer reads this instead of the old global atom.
 */
export const activeStatusBarStateAtom = atom<GlobalStatusBarState>((get) => {
  const activeApp = get(activeStatusBarAppAtom);
  const perApp = get(perAppStatusBarStateAtom);
  return perApp[activeApp];
});
activeStatusBarStateAtom.debugLabel = "activeStatusBarState";

/**
 * Returns a write atom that always targets the given app's state slot,
 * regardless of which app is currently active.
 *
 * Each app module should call this once (outside the component) with its own
 * fixed appType so its effects never accidentally write to a different slot.
 */
export function makeStatusBarStateAtom(app: StatusBarAppType) {
  const result = atom(
    (get) => get(perAppStatusBarStateAtom)[app],
    (
      get,
      set,
      update:
        | GlobalStatusBarState
        | ((prev: GlobalStatusBarState) => GlobalStatusBarState)
    ) => {
      const perApp = get(perAppStatusBarStateAtom);
      const prev = perApp[app];
      const newState = typeof update === "function" ? update(prev) : update;
      set(perAppStatusBarStateAtom, { ...perApp, [app]: newState });
    }
  );
  result.debugLabel = `statusBarState[${app}]`;
  return result;
}

/** Pre-built per-app state atoms — import the one matching your module. */
export const codeStatusBarStateAtom = makeStatusBarStateAtom("code");
export const browserStatusBarStateAtom = makeStatusBarStateAtom("browser");
export const dataStatusBarStateAtom = makeStatusBarStateAtom("data");
export const projectStatusBarStateAtom = makeStatusBarStateAtom("project");

/**
 * @deprecated Use the per-app atom (codeStatusBarStateAtom, etc.) so writes
 * always target the correct slot regardless of which app is currently active.
 */
export const globalStatusBarStateAtom = atom(
  (get) => get(activeStatusBarStateAtom),
  (
    get,
    set,
    update:
      | GlobalStatusBarState
      | ((prev: GlobalStatusBarState) => GlobalStatusBarState)
  ) => {
    const perApp = get(perAppStatusBarStateAtom);
    const activeApp = get(activeStatusBarAppAtom);
    const prev = perApp[activeApp];
    const newState = typeof update === "function" ? update(prev) : update;
    set(perAppStatusBarStateAtom, { ...perApp, [newState.appType]: newState });
  }
);
globalStatusBarStateAtom.debugLabel = "globalStatusBarState";

// ============================================
// Per-App Callbacks
// ============================================

export interface StatusBarCallbacks {
  onRepoClick?: () => void;
  onBranchClick?: () => void;
  onWorktreeClick?: () => void;
  /** Opens editor settings tab (Code / Project Manager — registered from AppShell). */
  onOpenSettings?: () => void;
  /** Toggles the primary sidebar panel (left or right depending on layoutMode). */
  onTogglePrimaryPanel?: () => void;
  /** Whether the primary sidebar panel is currently collapsed. */
  primaryPanelCollapsed?: boolean;
  /** Current sidebar layout mode. */
  layoutMode?: "left" | "right";
  /** Toggles the bottom panel (terminal/output — Code Editor only). */
  onToggleBottomPanel?: () => void;
  /** Whether the bottom panel is currently collapsed. */
  bottomPanelCollapsed?: boolean;
  onToggleDevTools?: () => void;
  /** Whether the DevTools panel is currently open (Browser only). */
  devToolsOpen?: boolean;
  onPrevSession?: () => void;
  onNextSession?: () => void;
  /** Send the currently inspector-selected DOM element to the Chat composer. */
  onSendSelectedElementToChat?: () => void;
  /** Clear the current inspector element selection. */
  onClearSelectedElement?: () => void;
}

/**
 * Per-app callbacks map. Each app registers its own callbacks.
 */
export const perAppStatusBarCallbacksAtom = atom<
  Record<StatusBarAppType, StatusBarCallbacks>
>({
  code: {},
  data: {},
  browser: {},
  project: {},
});
perAppStatusBarCallbacksAtom.debugLabel = "perAppStatusBarCallbacks";

/**
 * Derived: returns callbacks for the currently active app.
 */
export const activeStatusBarCallbacksAtom = atom<StatusBarCallbacks>((get) => {
  const activeApp = get(activeStatusBarAppAtom);
  const perApp = get(perAppStatusBarCallbacksAtom);
  return perApp[activeApp];
});
activeStatusBarCallbacksAtom.debugLabel = "activeStatusBarCallbacks";

/**
 * Returns a write atom that always targets the given app's callbacks slot,
 * regardless of which app is currently active.
 *
 * Each app module should call this once (outside the component) with its own
 * fixed appType so cleanup effects never accidentally clear another app's slot.
 */
export function makeStatusBarCallbacksAtom(app: StatusBarAppType) {
  const result = atom(
    (get) => get(perAppStatusBarCallbacksAtom)[app],
    (
      get,
      set,
      update:
        | StatusBarCallbacks
        | ((prev: StatusBarCallbacks) => StatusBarCallbacks)
    ) => {
      const perApp = get(perAppStatusBarCallbacksAtom);
      const prev = perApp[app];
      const newCallbacks = typeof update === "function" ? update(prev) : update;
      set(perAppStatusBarCallbacksAtom, { ...perApp, [app]: newCallbacks });
    }
  );
  result.debugLabel = `statusBarCallbacks[${app}]`;
  return result;
}

/** Pre-built per-app callback atoms — import the one matching your module. */
export const codeStatusBarCallbacksAtom = makeStatusBarCallbacksAtom("code");
export const browserStatusBarCallbacksAtom =
  makeStatusBarCallbacksAtom("browser");
export const dataStatusBarCallbacksAtom = makeStatusBarCallbacksAtom("data");
export const projectStatusBarCallbacksAtom =
  makeStatusBarCallbacksAtom("project");
