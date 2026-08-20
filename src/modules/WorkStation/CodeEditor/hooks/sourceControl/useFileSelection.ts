/**
 * Hook for managing file selection and filtering
 *
 * Note: This hook now uses 'staged' property for tracking which files
 * are selected for commit (matches git staging area concept).
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
  useState,
} from "react";

import type { GitFile } from "@src/types/git/types";

export interface UseFileSelectionOptions {
  files: GitFile[];
  setFiles?: Dispatch<SetStateAction<GitFile[]>>;
  selectedFileId: string;
}

export interface UseFileSelectionResult {
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  filteredFiles: GitFile[];
  selectedFile: GitFile | undefined;
  /** All visible files are staged */
  allFilesStaged: boolean;
  /** Some (but not all) visible files are staged */
  someFilesStaged: boolean;
  /** Count of staged files */
  stagedFilesCount: number;
  /** Toggle staging for a single file */
  handleFileStageChange: (fileId: string, staged: boolean) => void;
  /** Toggle staging for all visible files */
  handleSelectAllChange: (staged: boolean) => void;
  // Aliases
  allFilesChecked: boolean;
  someFilesChecked: boolean;
  checkedFilesCount: number;
  handleFileCheckChange: (fileId: string, checked: boolean) => void;
}

export function useFileSelection(
  options: UseFileSelectionOptions
): UseFileSelectionResult {
  const { files, setFiles, selectedFileId } = options;

  const [searchQuery, setSearchQuery] = useState("");

  // Filter files based on search
  const filteredFiles = useMemo(
    () =>
      files.filter((file) =>
        file.path.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [files, searchQuery]
  );

  // Get selected file
  const selectedFile = files.find((file) => file.id === selectedFileId);

  // Stage/unstage handlers
  const handleFileStageChange = useCallback(
    (fileId: string, staged: boolean) => {
      if (!setFiles) return;
      setFiles((prev) => {
        const targetFile = prev.find((file) => file.id === fileId);
        if (targetFile?.staged === staged) {
          return prev; // No change
        }
        return prev.map((file) =>
          file.id === fileId ? { ...file, staged } : file
        );
      });
    },
    [setFiles]
  );

  const handleSelectAllChange = useCallback(
    (_staged: boolean) => {
      if (!setFiles) return;
      setFiles((prevFiles) => {
        const currentFilteredFiles = prevFiles.filter((file) =>
          file.path.toLowerCase().includes(searchQuery.toLowerCase())
        );

        // Toggle: if all staged, unstage all; otherwise stage all
        const allCurrentlyStaged =
          currentFilteredFiles.length > 0 &&
          currentFilteredFiles.every((file) => file.staged);

        const shouldStage = !allCurrentlyStaged;

        const filteredFileIds = new Set(
          currentFilteredFiles.map((file) => file.id)
        );

        const needsUpdate = prevFiles.some(
          (file) => filteredFileIds.has(file.id) && file.staged !== shouldStage
        );

        if (!needsUpdate) {
          return prevFiles;
        }

        return prevFiles.map((file) =>
          filteredFileIds.has(file.id) ? { ...file, staged: shouldStage } : file
        );
      });
    },
    [searchQuery, setFiles]
  );

  // Computed values
  const allFilesStaged = useMemo(
    () =>
      filteredFiles.length > 0 && filteredFiles.every((file) => file.staged),
    [filteredFiles]
  );

  const someFilesStaged = useMemo(
    () => filteredFiles.some((file) => file.staged) && !allFilesStaged,
    [filteredFiles, allFilesStaged]
  );

  const stagedFilesCount = useMemo(
    () => files.filter((file) => file.staged).length,
    [files]
  );

  return {
    searchQuery,
    setSearchQuery,
    filteredFiles,
    selectedFile,
    // New staged-based API
    allFilesStaged,
    someFilesStaged,
    stagedFilesCount,
    handleFileStageChange,
    handleSelectAllChange,
    // Aliases
    allFilesChecked: allFilesStaged,
    someFilesChecked: someFilesStaged,
    checkedFilesCount: stagedFilesCount,
    handleFileCheckChange: handleFileStageChange,
  };
}
