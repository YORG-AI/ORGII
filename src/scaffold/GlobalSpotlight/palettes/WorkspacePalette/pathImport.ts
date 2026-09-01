import { homeDir } from "@tauri-apps/api/path";
import { message as showTauriMessage } from "@tauri-apps/plugin-dialog";

import { repoApi } from "@src/api/tauri/repo";

const ABSOLUTE_PATH_PATTERN = /^(?:~\/|\/|[A-Za-z]:[\\/])/;

interface ImportWorkspacePathArgs {
  candidatePath: string;
  invalidPathTitle: string;
  invalidPathMessage: (path: string) => string;
  onImportWorkspace: (path: string) => Promise<unknown>;
}

export function looksLikeWorkspacePath(value: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(value.trim());
}

export function getWorkspacePathCandidate(value: string): string | null {
  const candidatePath = value.trim();
  return looksLikeWorkspacePath(candidatePath) ? candidatePath : null;
}

export function getWorkspacePathDisplayName(path: string): string {
  const normalizedPath = path.trim().replace(/[\\/]+$/, "");
  if (!normalizedPath) return path.trim();
  const segments = normalizedPath.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) ?? normalizedPath;
}

export async function expandHomePath(path: string): Promise<string> {
  const trimmedPath = path.trim();
  if (!trimmedPath.startsWith("~/")) return trimmedPath;

  const home = await homeDir();
  return `${home.replace(/[\\/]$/, "")}/${trimmedPath.slice(2)}`;
}

async function showInvalidWorkspacePathDialog(
  title: string,
  dialogMessage: string
): Promise<void> {
  await showTauriMessage(dialogMessage, {
    title,
    kind: "error",
    buttons: { ok: "OK" },
  });
}

export async function importWorkspacePath({
  candidatePath,
  invalidPathTitle,
  invalidPathMessage,
  onImportWorkspace,
}: ImportWorkspacePathArgs): Promise<boolean> {
  const workspacePath = getWorkspacePathCandidate(candidatePath);
  if (!workspacePath) return false;

  try {
    const expandedPath = await expandHomePath(workspacePath);
    const validatedPath = await repoApi.validateWorkspacePath(expandedPath);
    await onImportWorkspace(validatedPath);
    return true;
  } catch {
    await showInvalidWorkspacePathDialog(
      invalidPathTitle,
      invalidPathMessage(workspacePath)
    );
    return true;
  }
}
