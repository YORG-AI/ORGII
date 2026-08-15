import { createLogger } from "@src/hooks/logger";

import {
  type WorkStationTab,
  type WorkStationTabType,
  type WorkstationTabRef,
  type WorkstationTabsStateV3,
  type WorkstationWorkspaceId,
  type WorkstationWorkspaceKey,
  type WorkstationWorkspaceState,
  getWorkstationTabOwnership,
} from "./types";

const log = createLogger("workStationTabs");

/** Legacy single-pane key, read only by the v2 -> v3 migrator. */
export const LAYOUT_STORAGE_KEY = "workstation:layout-v2";
export const WORKSTATION_V3_MANIFEST_KEY = "workstation:tabs:v3:manifest";
export const WORKSTATION_V3_SHARED_KEY = "workstation:tabs:v3:shared";
export const WORKSTATION_V3_GLOBAL_KEY = "workstation:tabs:v3:global";
export const WORKSTATION_V3_LEGACY_SEED_KEY = "workstation:tabs:v3:legacy-seed";
const WORKSTATION_V3_SESSION_PREFIX = "workstation:tabs:v3:session:";

const VALID_WORKSTATION_TAB_TYPES = new Set<WorkStationTabType>([
  "file",
  "directory",
  "explorer",
  "git-diff",
  "source-control",
  "timeline-diff",
  "git-log",
  "git-commit-detail",
  "git-stash-detail",
  "terminal-content",
  "dom-component-preview",
  "terminal",
  "output",
  "settings",
  "search",
  "lint-scan",
  "ai-impact",
  "search-sessions",
  "url-preview",
  "browser-session",
  "devtools",
  "project-dashboard",
  "project-work-items",
  "project-linear-projects",
  "project-linear-work-items",
  "project-settings",
  "project-org",
  "project-org-settings",
  "project-git-sync-review",
  "project-workitems",
  "workItem-detail",
  "chat-session",
  "subagent-detail",
  "agent-config",
  "canvas-preview",
  "github-issue-detail",
  "github-pr-detail",
  "start",
]);

const MAX_TABS_PER_PARTITION = 200;
const EMPTY_WORKSPACE: WorkstationWorkspaceState = {
  tabs: [],
  activeTabRef: null,
  tabOrder: [],
};

interface ManifestV3 {
  version: 3;
  sessionIds: string[];
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidTab(value: unknown): value is WorkStationTab {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 2048 &&
    typeof value.type === "string" &&
    VALID_WORKSTATION_TAB_TYPES.has(value.type as WorkStationTabType) &&
    typeof value.title === "string" &&
    isPlainObject(value.data)
  );
}

function sanitizeTabs(value: unknown): WorkStationTab[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: WorkStationTab[] = [];
  for (const candidate of value) {
    if (!isValidTab(candidate) || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    // A dirty marker without a restored buffer is misleading after restart.
    result.push({ ...candidate, hasUnsavedChanges: false });
    if (result.length >= MAX_TABS_PER_PARTITION) break;
  }
  return result;
}

function isTabRef(value: unknown): value is WorkstationTabRef {
  return (
    isPlainObject(value) &&
    (value.partition === "shared" || value.partition === "workspace") &&
    typeof value.tabId === "string"
  );
}

export function sanitizeWorkspaceState(
  value: unknown
): WorkstationWorkspaceState {
  if (!isPlainObject(value)) return { ...EMPTY_WORKSPACE };
  const tabs = sanitizeTabs(value.tabs).filter(
    (tab) => getWorkstationTabOwnership(tab.type) === "workspace-local"
  );
  const localIds = new Set(tabs.map((tab) => tab.id));
  const rawOrder = Array.isArray(value.tabOrder)
    ? value.tabOrder.filter(isTabRef)
    : [];
  const seenRefs = new Set<string>();
  const tabOrder = rawOrder.filter((ref) => {
    const identity = `${ref.partition}:${ref.tabId}`;
    if (seenRefs.has(identity)) return false;
    if (ref.partition === "workspace" && !localIds.has(ref.tabId)) return false;
    seenRefs.add(identity);
    return true;
  });
  for (const tab of tabs) {
    const identity = `workspace:${tab.id}`;
    if (!seenRefs.has(identity)) {
      tabOrder.push({ partition: "workspace", tabId: tab.id });
      seenRefs.add(identity);
    }
  }
  const activeTabRef = isTabRef(value.activeTabRef)
    ? value.activeTabRef.partition === "workspace" &&
      !localIds.has(value.activeTabRef.tabId)
      ? null
      : value.activeTabRef
    : null;
  return { tabs, activeTabRef, tabOrder };
}

function sanitizeSharedTabs(value: unknown): WorkStationTab[] {
  const rawTabs = isPlainObject(value) ? value.tabs : value;
  return sanitizeTabs(rawTabs).filter(
    (tab) => getWorkstationTabOwnership(tab.type) === "shared-resource"
  );
}

function readJson(key: string): unknown {
  if (!hasLocalStorage()) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  if (!hasLocalStorage()) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    log.error(`[workStationTabs] Failed to persist ${key}:`, error);
    return false;
  }
}

export function workstationWorkspaceId(
  key: WorkstationWorkspaceKey
): WorkstationWorkspaceId {
  return key.kind === "global" ? "global" : `session:${key.sessionId}`;
}

function sessionStorageKey(sessionId: string): string {
  return `${WORKSTATION_V3_SESSION_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function emptyWorkstationTabsState(): WorkstationTabsStateV3 {
  return {
    version: 3,
    shared: { tabs: [] },
    globalWorkspace: { ...EMPTY_WORKSPACE },
    sessionWorkspaces: {},
    legacySeed: null,
  };
}

function migrateLegacyV2(): WorkstationTabsStateV3 {
  const state = emptyWorkstationTabsState();
  const legacy = readJson(LAYOUT_STORAGE_KEY);
  if (!isPlainObject(legacy) || !isPlainObject(legacy.mainPane)) return state;
  const panel = legacy.mainPane;
  const tabs = sanitizeTabs(panel.tabs);
  const shared = tabs.filter(
    (tab) => getWorkstationTabOwnership(tab.type) === "shared-resource"
  );
  const local = tabs.filter(
    (tab) => getWorkstationTabOwnership(tab.type) === "workspace-local"
  );
  state.shared.tabs = shared;
  if (local.length > 0) {
    const activeId =
      typeof panel.activeTabId === "string" ? panel.activeTabId : null;
    state.legacySeed = {
      tabs: local,
      activeTabRef: activeId
        ? shared.some((tab) => tab.id === activeId)
          ? { partition: "shared", tabId: activeId }
          : local.some((tab) => tab.id === activeId)
            ? { partition: "workspace", tabId: activeId }
            : null
        : null,
      tabOrder: tabs.map((tab) => ({
        partition:
          getWorkstationTabOwnership(tab.type) === "shared-resource"
            ? "shared"
            : "workspace",
        tabId: tab.id,
      })),
    };
  }
  persistWorkstationTabsState(state);
  return state;
}

export function loadWorkstationTabsState(): WorkstationTabsStateV3 {
  if (!hasLocalStorage()) return emptyWorkstationTabsState();
  const manifest = readJson(WORKSTATION_V3_MANIFEST_KEY);
  if (!isPlainObject(manifest) || manifest.version !== 3) {
    return migrateLegacyV2();
  }
  const sessionIds = Array.isArray(manifest.sessionIds)
    ? manifest.sessionIds.filter((id): id is string => typeof id === "string")
    : [];
  const sessionWorkspaces: Record<string, WorkstationWorkspaceState> = {};
  for (const sessionId of sessionIds) {
    sessionWorkspaces[sessionId] = sanitizeWorkspaceState(
      readJson(sessionStorageKey(sessionId))
    );
  }
  const rawLegacySeed = readJson(WORKSTATION_V3_LEGACY_SEED_KEY);
  return {
    version: 3,
    shared: { tabs: sanitizeSharedTabs(readJson(WORKSTATION_V3_SHARED_KEY)) },
    globalWorkspace: sanitizeWorkspaceState(
      readJson(WORKSTATION_V3_GLOBAL_KEY)
    ),
    sessionWorkspaces,
    legacySeed: rawLegacySeed ? sanitizeWorkspaceState(rawLegacySeed) : null,
  };
}

export function persistWorkstationTabsState(
  state: WorkstationTabsStateV3
): boolean {
  if (!hasLocalStorage()) return false;
  const sessionIds = Object.keys(state.sessionWorkspaces);
  const writes = [
    writeJson(WORKSTATION_V3_SHARED_KEY, state.shared),
    writeJson(WORKSTATION_V3_GLOBAL_KEY, state.globalWorkspace),
    state.legacySeed
      ? writeJson(WORKSTATION_V3_LEGACY_SEED_KEY, state.legacySeed)
      : (() => {
          localStorage.removeItem(WORKSTATION_V3_LEGACY_SEED_KEY);
          return true;
        })(),
    ...sessionIds.map((id) =>
      writeJson(sessionStorageKey(id), state.sessionWorkspaces[id])
    ),
  ];
  if (writes.some((ok) => !ok)) return false;
  const manifest: ManifestV3 = { version: 3, sessionIds };
  const committed = writeJson(WORKSTATION_V3_MANIFEST_KEY, manifest);
  // Keep v2 as a recovery source until its workspace-local seed has been
  // successfully claimed by an explicit session.
  if (committed && state.legacySeed === null) {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  }
  return committed;
}

export function deletePersistedWorkstationWorkspace(sessionId: string): void {
  if (!hasLocalStorage()) return;
  localStorage.removeItem(sessionStorageKey(sessionId));
}
