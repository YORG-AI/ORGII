/**
 * FileOperationsService - Unified File Operations Service
 *
 * Provides file operations with full UI parity:
 * - Opens files with tab creation (like clicking in file tree)
 * - Saves with proper dirty state management
 * - Create/Delete/Rename with dialogs and tree refresh
 *
 * This is the SINGLE implementation that all paths should use:
 * - dispatch("file.open") → FileOperationsService.open()
 * - File tree click → dispatch("file.open")
 * - AI command → dispatch("file.open")
 *
 * Usage:
 *   import { FileOperationsService } from "@src/services/file";
 *   const result = await FileOperationsService.open("/path/to/file.ts");
 */
import { copyFile, mkdir, readDir } from "@tauri-apps/plugin-fs";

import { createLogger } from "@src/hooks/logger";
import { EditorTabService } from "@src/services/workStation/EditorTabService";
import { fileClipboardAtom } from "@src/store/workstation/codeEditor/file/clipboardAtom";
import { createFileTab } from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { FileService } from "./FileService";

const log = createLogger("FileOperationsService");

// ============================================
// Types
// ============================================

export interface FileOperationResult {
  success: boolean;
  message?: string;
}

// ============================================
// FileOperationsService - Singleton API
// ============================================

export const FileOperationsService = {
  /**
   * Open a file in the editor WITH tab creation
   * This matches the behavior of clicking a file in the file tree
   */
  async open(path: string): Promise<FileOperationResult> {
    try {
      // First, load the file content via FileService
      await FileService.open(path);

      // Create a tab using the same helper as file tree clicks
      // This ensures consistent tab structure (includes extension, status, etc.)
      const tab = createFileTab(path);
      EditorTabService.openTab(tab);
      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open file";
      log.error("[FileOperationsService] Failed to open:", error);
      return { success: false, message };
    }
  },

  /**
   * Open a file and jump to a specific line
   */
  async openAtLine(path: string, line: number): Promise<FileOperationResult> {
    try {
      // First, load the file content via FileService
      await FileService.open(path);

      // Create a tab with targetLine for navigation
      const tab = createFileTab(path, line);
      EditorTabService.openTab(tab);

      // Also emit event for editor to handle (in case tab already exists)
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("editor-go-to-line", { detail: { line } })
        );
      }, 100);
      return { success: true, message: `Opened ${path} at line ${line}` };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open file";
      log.error("[FileOperationsService] Failed to open at line:", error);
      return { success: false, message };
    }
  },

  /**
   * Save the current file or a specific file
   */
  async save(path?: string): Promise<FileOperationResult> {
    try {
      const success = await FileService.save(path);
      if (success) {
        // Tab dirty state is managed via atoms, FileService.save already handles this
        return { success: true, message: "File saved" };
      }
      return { success: false, message: "Failed to save file" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save file";
      return { success: false, message };
    }
  },

  /**
   * Create a new file
   * Creates the file, refreshes tree, and opens in editor
   */
  async create(
    path: string,
    content: string = ""
  ): Promise<FileOperationResult> {
    try {
      const success = await FileService.create(path, content);
      if (success) {
        // FileService.create already opens the file and refreshes tree
        // Ensure the tab is created with consistent structure
        const tab = createFileTab(path);
        EditorTabService.openTab(tab);
        return { success: true, message: `Created: ${path}` };
      }
      return { success: false, message: "Failed to create file" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create file";
      return { success: false, message };
    }
  },

  /**
   * Delete a file or directory
   * Closes any open tabs for the deleted file
   */
  async delete(path: string): Promise<FileOperationResult> {
    try {
      // Close any tabs for this file first
      const tabId = `file:${path}`;
      EditorTabService.closeTab(tabId);

      const success = await FileService.delete(path);
      if (success) {
        return { success: true, message: `Deleted: ${path}` };
      }
      return { success: false, message: "Failed to delete file" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to delete file";
      return { success: false, message };
    }
  },

  /**
   * Rename a file or directory
   * Updates any open tabs with the new path (files only - folders don't have tabs)
   */
  async rename(oldPath: string, newPath: string): Promise<FileOperationResult> {
    try {
      // Check if this file had an open tab (only files have tabs, not folders)
      const oldTabId = `file:${oldPath}`;
      const hadOpenTab = EditorTabService.hasTab(oldTabId);

      // Close old tab if it existed
      if (hadOpenTab) {
        EditorTabService.closeTab(oldTabId);
      }

      const success = await FileService.rename(oldPath, newPath);
      if (success) {
        // Only re-open tab if the file was previously open (don't create tabs for folders)
        if (hadOpenTab) {
          const tab = createFileTab(newPath);
          EditorTabService.openTab(tab);
        }
        return {
          success: true,
          message: `Renamed: ${oldPath} → ${newPath}`,
        };
      }
      return { success: false, message: "Failed to rename file" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to rename file";
      return { success: false, message };
    }
  },

  /**
   * Reveal a file in the file explorer panel
   */
  async reveal(
    path: string,
    options?: { expandTargetDirectory?: boolean }
  ): Promise<FileOperationResult> {
    try {
      await FileService.reveal(path, options);
      return { success: true, message: `Revealed: ${path}` };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reveal file";
      return { success: false, message };
    }
  },

  /**
   * Reveal a file in the OS file manager (Finder/Explorer)
   */
  async revealInFinder(path: string): Promise<FileOperationResult> {
    try {
      const success = await FileService.revealInFinder(path);
      if (success) {
        return { success: true, message: `Revealed in Finder: ${path}` };
      }
      return { success: false, message: "Failed to reveal in Finder" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reveal in Finder";
      return { success: false, message };
    }
  },

  /**
   * Refresh the file tree
   */
  async refresh(): Promise<FileOperationResult> {
    try {
      await FileService.refresh();
      return { success: true, message: "File tree refreshed" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to refresh";
      return { success: false, message };
    }
  },

  /**
   * Collapse all directories in the file tree
   */
  collapseAll(): FileOperationResult {
    try {
      FileService.collapseAll();
      return { success: true, message: "Collapsed all directories" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to collapse";
      return { success: false, message };
    }
  },

  /**
   * Create a new folder
   */
  async createFolder(path: string): Promise<FileOperationResult> {
    try {
      await mkdir(path, { recursive: true });
      // Refresh tree to show the new folder
      await FileService.refresh();
      return { success: true, message: `Created folder: ${path}` };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create folder";
      log.error("[FileOperationsService] Failed to create folder:", error);
      return { success: false, message };
    }
  },

  /**
   * Copy file/folder paths to clipboard for paste operation
   * Stores paths in the clipboard atom for later paste
   */
  async copy(paths: string[]): Promise<FileOperationResult> {
    try {
      const store = getInstrumentedStore();
      store.set(fileClipboardAtom, {
        paths,
        operation: "copy",
      });
      return {
        success: true,
        message: `Copied ${paths.length} item(s) to clipboard`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to copy";
      log.error("[FileOperationsService] Failed to copy:", error);
      return { success: false, message };
    }
  },

  /**
   * Paste files from clipboard to target directory
   */
  async paste(targetDir: string): Promise<FileOperationResult> {
    try {
      const store = getInstrumentedStore();
      const clipboard = store.get(fileClipboardAtom);

      if (!clipboard || clipboard.paths.length === 0) {
        return { success: false, message: "Nothing to paste" };
      }

      const { paths } = clipboard;
      let pastedCount = 0;

      for (const sourcePath of paths) {
        const fileName = sourcePath.split("/").pop() || "";
        const destPath = `${targetDir}/${fileName}`;

        // Check if it's a directory or file and copy accordingly
        try {
          // readDir succeeds for directories, throws for files
          await readDir(sourcePath);
          // It's a directory - copy recursively
          await this._copyDirectoryRecursive(sourcePath, destPath);
          pastedCount++;
        } catch {
          // It's a file - use copyFile
          try {
            await copyFile(sourcePath, destPath);
            pastedCount++;
          } catch (copyError) {
            log.error(
              `[FileOperationsService] Failed to copy ${sourcePath}:`,
              copyError
            );
          }
        }
      }

      // Refresh tree to show pasted files
      await FileService.refresh();

      if (pastedCount > 0) {
        return {
          success: true,
          message: `Pasted ${pastedCount} item(s)`,
        };
      }
      return { success: false, message: "Failed to paste any items" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to paste";
      log.error("[FileOperationsService] Failed to paste:", error);
      return { success: false, message };
    }
  },

  /**
   * Helper to copy a directory recursively
   */
  async _copyDirectoryRecursive(
    sourcePath: string,
    destPath: string
  ): Promise<void> {
    // Create destination directory
    await mkdir(destPath, { recursive: true });

    // Read source directory contents
    const entries = await readDir(sourcePath);

    for (const entry of entries) {
      const sourceEntryPath = `${sourcePath}/${entry.name}`;
      const destEntryPath = `${destPath}/${entry.name}`;

      if (entry.isDirectory) {
        // Recursively copy subdirectory
        await this._copyDirectoryRecursive(sourceEntryPath, destEntryPath);
      } else {
        // Copy file
        await copyFile(sourceEntryPath, destEntryPath);
      }
    }
  },

  /**
   * Duplicate a file or folder with an incremented name
   * e.g., file.ts -> file copy.ts, folder -> folder copy
   */
  async duplicate(path: string): Promise<FileOperationResult> {
    try {
      const fileName = path.split("/").pop() || "";
      const parentDir = path.substring(0, path.lastIndexOf("/"));

      // Generate new name with "copy" suffix
      let newName: string;
      const lastDotIndex = fileName.lastIndexOf(".");

      if (lastDotIndex > 0) {
        // File with extension: file.ts -> file copy.ts
        const baseName = fileName.substring(0, lastDotIndex);
        const extension = fileName.substring(lastDotIndex);
        newName = `${baseName} copy${extension}`;
      } else {
        // Folder or file without extension
        newName = `${fileName} copy`;
      }

      const newPath = `${parentDir}/${newName}`;

      // Check if it's a directory or file
      try {
        await readDir(path);
        // It's a directory - copy recursively
        await this._copyDirectoryRecursive(path, newPath);
      } catch {
        // It's a file - use copyFile
        await copyFile(path, newPath);
      }

      // Refresh tree to show the duplicate
      await FileService.refresh();

      return {
        success: true,
        message: `Duplicated: ${fileName} → ${newName}`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to duplicate";
      log.error("[FileOperationsService] Failed to duplicate:", error);
      return { success: false, message };
    }
  },
};
