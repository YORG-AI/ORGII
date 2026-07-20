import { exists, readDir, stat } from "@tauri-apps/plugin-fs";

import { toFsPluginPath } from "@src/util/file/pathUtils";

export interface DirectoryEntryRow {
  name: string;
  path: string;
  type: "directory" | "file";
}

export type DirectoryOpenErrorKind =
  | "not_found"
  | "not_directory"
  | "permission"
  | "unknown";

export class DirectoryOpenError extends Error {
  constructor(
    public readonly kind: DirectoryOpenErrorKind,
    message: string
  ) {
    super(message);
    this.name = "DirectoryOpenError";
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function classifyDirectoryOpenError(error: unknown): DirectoryOpenError {
  if (error instanceof DirectoryOpenError) return error;

  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("no such file") ||
    normalized.includes("not found") ||
    normalized.includes("enoent") ||
    normalized.includes("os error 2")
  ) {
    return new DirectoryOpenError("not_found", message);
  }

  if (
    normalized.includes("not a directory") ||
    normalized.includes("enotdir")
  ) {
    return new DirectoryOpenError("not_directory", message);
  }

  if (
    normalized.includes("permission") ||
    normalized.includes("forbidden") ||
    normalized.includes("not allowed") ||
    normalized.includes("access denied") ||
    normalized.includes("eacces") ||
    normalized.includes("eperm")
  ) {
    return new DirectoryOpenError("permission", message);
  }

  return new DirectoryOpenError("unknown", message);
}

export async function loadDirectoryEntries(
  directoryPath: string
): Promise<DirectoryEntryRow[]> {
  // On Windows the repo path arrives canonicalized as `\\?\C:\...`, which
  // the Tauri fs plugin cannot read. Child paths must use the cleaned form too.
  const dir = toFsPluginPath(directoryPath).replace(/\/+$/, "");

  let pathExists: boolean;
  try {
    pathExists = await exists(dir);
  } catch (error) {
    throw classifyDirectoryOpenError(error);
  }

  if (!pathExists) {
    throw new DirectoryOpenError("not_found", "Directory does not exist");
  }

  try {
    const info = await stat(dir);
    if (!info.isDirectory) {
      throw new DirectoryOpenError(
        "not_directory",
        "Path points to a file, not a directory"
      );
    }
  } catch (error) {
    throw classifyDirectoryOpenError(error);
  }

  try {
    const entries = await readDir(dir);
    return entries
      .map((entry) => ({
        name: entry.name,
        path: `${dir}/${entry.name}`,
        type: entry.isDirectory ? ("directory" as const) : ("file" as const),
      }))
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
  } catch (error) {
    throw classifyDirectoryOpenError(error);
  }
}
