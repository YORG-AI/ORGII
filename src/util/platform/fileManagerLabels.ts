import { isMacOS, isWindows } from "./tauri";

export interface FileManagerRevealLabelKeys {
  finder: string;
  explorer: string;
  fileManager: string;
}

export const COMMON_FILE_MANAGER_REVEAL_KEYS: FileManagerRevealLabelKeys = {
  finder: "common:actions.revealInFinder",
  explorer: "common:actions.revealInWindowsExplorer",
  fileManager: "common:actions.revealInFileManager",
};

export function getFileManagerRevealLabelKey(
  keys: FileManagerRevealLabelKeys = COMMON_FILE_MANAGER_REVEAL_KEYS
): string {
  if (isMacOS()) return keys.finder;
  if (isWindows()) return keys.explorer;
  return keys.fileManager;
}
