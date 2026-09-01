/**
 * Sidebar group-by preference atoms
 *
 * Persists sidebar grouping choices to localStorage so the user's
 * sort/grouping choice survives reloads. Used only by
 * `WorkstationSidebarConnector` — keep colocated rather than promoting to
 * `src/store/`.
 */
import { atomWithStorage } from "jotai/utils";

import {
  GROUP_BY_MODES,
  type GroupByMode,
  PROJECTS_GROUP_BY_MODES,
  type ProjectsGroupByMode,
} from "./types";

const STORAGE_KEY = "orgii:sidebarGroupBy";
const HIDDEN_WORKSPACES_STORAGE_KEY = "orgii:sidebarHiddenWorkspaces";
const PINNED_WORKSPACES_STORAGE_KEY = "orgii:sidebarPinnedWorkspaces";
const PROJECTS_STORAGE_KEY = "orgii:projectsSidebarGroupBy";
const INCLUDE_EXTERNAL_STORAGE_KEY = "orgii:sidebarIncludeExternal";
const DEFAULT_MODE: GroupByMode = "byTime";
const DEFAULT_PROJECTS_MODE: ProjectsGroupByMode = "byOrg";
const DEFAULT_INCLUDE_EXTERNAL = true;

const KNOWN_MODES = new Set<GroupByMode>(GROUP_BY_MODES);
const KNOWN_PROJECTS_MODES = new Set<ProjectsGroupByMode>(
  PROJECTS_GROUP_BY_MODES
);

function parseStored(raw: unknown): GroupByMode {
  if (typeof raw !== "string") return DEFAULT_MODE;
  if (KNOWN_MODES.has(raw as GroupByMode)) return raw as GroupByMode;
  return DEFAULT_MODE;
}

function parseStoredProjects(raw: unknown): ProjectsGroupByMode {
  if (typeof raw !== "string") return DEFAULT_PROJECTS_MODE;
  if (KNOWN_PROJECTS_MODES.has(raw as ProjectsGroupByMode)) {
    return raw as ProjectsGroupByMode;
  }
  return DEFAULT_PROJECTS_MODE;
}

function parseStoredBoolean(raw: unknown): boolean {
  return typeof raw === "boolean" ? raw : DEFAULT_INCLUDE_EXTERNAL;
}

function parseStoredWorkspaceKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0
      )
    )
  );
}

function createStorage<T>(parseValue: (raw: unknown) => T) {
  return {
    getItem(key: string, initialValue: T): T {
      if (typeof window === "undefined") return initialValue;
      try {
        const stored = window.localStorage.getItem(key);
        if (stored == null) return initialValue;
        return parseValue(JSON.parse(stored) as unknown);
      } catch {
        return initialValue;
      }
    },
    setItem(key: string, value: T) {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    removeItem(key: string) {
      if (typeof window === "undefined") return;
      window.localStorage.removeItem(key);
    },
  };
}

export const sidebarGroupByAtom = atomWithStorage<GroupByMode>(
  STORAGE_KEY,
  DEFAULT_MODE,
  createStorage(parseStored),
  { getOnInit: true }
);
sidebarGroupByAtom.debugLabel = "sidebarGroupByAtom";

const projectsSidebarGroupByAtom = atomWithStorage<ProjectsGroupByMode>(
  PROJECTS_STORAGE_KEY,
  DEFAULT_PROJECTS_MODE,
  createStorage(parseStoredProjects),
  { getOnInit: true }
);
projectsSidebarGroupByAtom.debugLabel = "projectsSidebarGroupByAtom";

export const sidebarIncludeExternalAtom = atomWithStorage<boolean>(
  INCLUDE_EXTERNAL_STORAGE_KEY,
  DEFAULT_INCLUDE_EXTERNAL,
  createStorage(parseStoredBoolean),
  { getOnInit: true }
);
sidebarIncludeExternalAtom.debugLabel = "sidebarIncludeExternalAtom";

/**
 * Workspace group keys the viewer hid from the Organize-by-workspace list.
 *
 * A key is the group's repo path (or `NO_WORKSPACE_KEY`), matching the section
 * id the sidebar collapses by. Hiding is a view preference, never a filter:
 * the group still renders, sorted last and collapsed, so its sessions stay
 * reachable and the state is reversible from the same `…` menu.
 */
export const sidebarHiddenWorkspacesAtom = atomWithStorage<string[]>(
  HIDDEN_WORKSPACES_STORAGE_KEY,
  [],
  createStorage(parseStoredWorkspaceKeys),
  { getOnInit: true }
);
sidebarHiddenWorkspacesAtom.debugLabel = "sidebarHiddenWorkspacesAtom";

/**
 * Workspace group keys the viewer pinned. Pinned groups sort above every other
 * workspace; pinning and hiding are mutually exclusive (see
 * `useWorkspaceGroupActions`), so a key never appears in both lists.
 */
export const sidebarPinnedWorkspacesAtom = atomWithStorage<string[]>(
  PINNED_WORKSPACES_STORAGE_KEY,
  [],
  createStorage(parseStoredWorkspaceKeys),
  { getOnInit: true }
);
sidebarPinnedWorkspacesAtom.debugLabel = "sidebarPinnedWorkspacesAtom";
