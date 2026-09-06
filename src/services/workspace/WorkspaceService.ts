/**
 * WorkspaceService
 *
 * Handles .orgii-workspace file import/export:
 * - Save/load workspace configurations to/from files
 * - "Save Workspace As..." to user-chosen location
 * - Recent workspace tracking (localStorage)
 */
import { createLogger } from "@src/hooks/logger";
import type {
  RecentWorkspace,
  WorkspaceConfig,
  WorkspaceFolder,
  WorkspaceFolderEntry,
} from "@src/types/workspace";
import { WORKSPACE_FILE_EXTENSION } from "@src/types/workspace";

const log = createLogger("WorkspaceService");

const LEGACY_RECENT_WORKSPACES_KEY = "soyd_recent_workspaces";
const RECENT_WORKSPACES_KEY = "orgii_recent_workspaces";
const RECENT_WORKSPACES_CHANGED_EVENT = "orgii:recent-workspaces-changed";

const MAX_RECENT_WORKSPACES = 7;

function foldersToEntries(folders: WorkspaceFolder[]): WorkspaceFolderEntry[] {
  return folders.map((folder) => ({
    path: folder.path,
    ...(folder.name !== folder.path.split("/").pop() && { name: folder.name }),
  }));
}

function entriesToFolders(entries: WorkspaceFolderEntry[]): WorkspaceFolder[] {
  return entries.map((entry, index) => ({
    id: crypto.randomUUID(),
    name: entry.name ?? entry.path.split("/").pop() ?? entry.path,
    path: entry.path,
    uri: `file://${entry.path}`,
    isPrimary: index === 0,
  }));
}

export async function saveWorkspace(
  filePath: string,
  folders: WorkspaceFolder[],
  settings?: Record<string, unknown>
): Promise<void> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  const config: WorkspaceConfig = {
    folders: foldersToEntries(folders),
    ...(settings && Object.keys(settings).length > 0 && { settings }),
  };
  await writeTextFile(filePath, JSON.stringify(config, null, 2));
}

export async function loadWorkspace(
  filePath: string
): Promise<WorkspaceFolder[]> {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const content = await readTextFile(filePath);
  const config = JSON.parse(content) as WorkspaceConfig;
  if (!Array.isArray(config.folders) || config.folders.length === 0) {
    throw new Error("Invalid workspace file: no folders defined");
  }
  return entriesToFolders(config.folders);
}

export async function saveWorkspaceAs(
  folders: WorkspaceFolder[]
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const filePath = await save({
    filters: [
      {
        name: "ORGII Workspace",
        extensions: [WORKSPACE_FILE_EXTENSION.replace(".", "")],
      },
    ],
    defaultPath: `workspace${WORKSPACE_FILE_EXTENSION}`,
  });
  if (!filePath) return null;

  await saveWorkspace(filePath, folders);
  return filePath;
}

export async function openWorkspaceFile(): Promise<{
  folders: WorkspaceFolder[];
  filePath: string;
} | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const filePath = await open({
    filters: [
      {
        name: "ORGII Workspace",
        extensions: [WORKSPACE_FILE_EXTENSION.replace(".", "")],
      },
    ],
    multiple: false,
  });
  if (!filePath || typeof filePath !== "string") return null;

  const folders = await loadWorkspace(filePath);
  return { folders, filePath };
}

// ============================================
// Recent Workspaces (top-N persisted to localStorage)
// ============================================

function migrateLegacyRecentWorkspaces(): string | null {
  const legacy = localStorage.getItem(LEGACY_RECENT_WORKSPACES_KEY);
  if (!legacy) return null;

  localStorage.setItem(RECENT_WORKSPACES_KEY, legacy);
  localStorage.removeItem(LEGACY_RECENT_WORKSPACES_KEY);
  return legacy;
}

function readRecentWorkspaces(): RecentWorkspace[] {
  try {
    let stored = localStorage.getItem(RECENT_WORKSPACES_KEY);
    if (!stored) {
      stored = migrateLegacyRecentWorkspaces();
    }
    if (!stored) return [];
    const parsed = JSON.parse(stored) as RecentWorkspace[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) =>
        typeof entry?.path === "string" &&
        typeof entry?.name === "string" &&
        typeof entry?.folderCount === "number"
    );
  } catch {
    return [];
  }
}

function writeRecentWorkspaces(entries: RecentWorkspace[]): void {
  try {
    localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(entries));
  } catch (error) {
    log.error("[WorkspaceService] Failed to write recent workspaces:", error);
  }
}

function workspaceDisplayNameFromPath(filePath: string): string {
  const filename = filePath.split("/").pop() ?? filePath;
  if (filename.endsWith(WORKSPACE_FILE_EXTENSION)) {
    return filename.slice(0, -WORKSPACE_FILE_EXTENSION.length);
  }
  return filename;
}

function notifyRecentWorkspacesChanged(): void {
  window.dispatchEvent(new CustomEvent(RECENT_WORKSPACES_CHANGED_EVENT));
}

/**
 * Record that a workspace file was opened. Bumps it to the top of the
 * recent list and trims to MAX_RECENT_WORKSPACES.
 */
export function recordRecentWorkspace(
  filePath: string,
  folders: WorkspaceFolder[]
): void {
  const entry: RecentWorkspace = {
    path: filePath,
    name: workspaceDisplayNameFromPath(filePath),
    folderCount: folders.length,
    lastOpened: Date.now(),
  };
  const existing = readRecentWorkspaces().filter(
    (item) => item.path !== filePath
  );
  const updated = [entry, ...existing].slice(0, MAX_RECENT_WORKSPACES);
  writeRecentWorkspaces(updated);
  notifyRecentWorkspacesChanged();
}

/**
 * List recent workspace files (most-recent-first). Cheap synchronous read
 * from localStorage; consumers that want fresh data should listen for
 * orgii:recent-workspaces-changed.
 */
export function listRecentWorkspaces(): RecentWorkspace[] {
  return readRecentWorkspaces();
}

/**
 * Close the current workspace by collapsing to single-root using the primary
 * folder, or clearing entirely if no folders. Returns the new folder list.
 */
export function closeWorkspace(folders: WorkspaceFolder[]): WorkspaceFolder[] {
  if (folders.length <= 1) return [];
  const primary = folders.find((folder) => folder.isPrimary) ?? folders[0];
  return [{ ...primary, isPrimary: true }];
}
