/**
 * useWorkspaceMemoryData
 *
 * Owns all data-fetching and mutation logic for WorkspaceMemoryBrowser.
 *
 * Responsibilities:
 * - List, read, delete, clear workspace memory files via RPC.
 * - Poll/refresh on demand.
 * - Derive the filtered + sorted file list from the raw list.
 * - Load the MEMORY.md index.
 * - Expand / collapse single file detail rows.
 *
 * Does NOT own UI state (sort Select value, search input, scope pill) —
 * those are passed in as arguments so the parent component keeps control
 * of filter/sort state that drives filter Select rendering.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type {
  WorkspaceMemoryDetail,
  WorkspaceMemoryEntry,
} from "@src/api/tauri/rpc/schemas/workspaceMemory";
import Message from "@src/components/Message";
import { useMounted } from "@src/hooks/lifecycle/useMounted";
import { useRefreshSpin } from "@src/hooks/ui";

export const MEMORY_TYPE_FILTER_ALL = "all" as const;

export const MEMORY_SORT_NAME = "name" as const;
export const MEMORY_SORT_NEWEST = "newest" as const;
export const MEMORY_SORT_OLDEST = "oldest" as const;
export const MEMORY_SORT_TYPE = "type" as const;

export type MemorySortKey =
  | typeof MEMORY_SORT_NAME
  | typeof MEMORY_SORT_NEWEST
  | typeof MEMORY_SORT_OLDEST
  | typeof MEMORY_SORT_TYPE;

export interface UseWorkspaceMemoryDataOptions {
  workspace: string | null | undefined;
  searchQuery: string;
  sortKey: MemorySortKey;
  typeFilter: string;
  onRefreshStatus: () => void;
}

export interface UseWorkspaceMemoryDataReturn {
  files: WorkspaceMemoryEntry[];
  filteredFiles: WorkspaceMemoryEntry[];
  selectedFile: string | null;
  detail: WorkspaceMemoryDetail | null;
  loading: boolean;
  showIndex: boolean;
  memoryIndex: string;
  expandedFileKeys: string[];
  spinClass: string | undefined;
  handleRefreshClick: () => void;
  handleShowIndex: () => void;
  handleDelete: (filename: string) => void;
  handleClearAll: () => void;
  setSingleExpandedFile: (entry: WorkspaceMemoryEntry) => void;
  loadFileDetail: (filename: string) => void;
  setExpandedFileKeys: (keys: string[]) => void;
  setSelectedFile: (filename: string | null) => void;
  setDetail: (detail: WorkspaceMemoryDetail | null) => void;
  setShowIndex: (show: boolean) => void;
  fetchFiles: () => void;
}

interface WorkspaceMemoryState {
  workspace: string | null | undefined;
  files: WorkspaceMemoryEntry[];
  selectedFile: string | null;
  detail: WorkspaceMemoryDetail | null;
  memoryIndex: string;
  loading: boolean;
  showIndex: boolean;
  expandedFileKeys: string[];
}

type WorkspaceMemoryAction =
  | {
      type: "resetWorkspace";
      workspace: string | null | undefined;
    }
  | { type: "beginList"; workspace: string }
  | {
      type: "receiveFiles";
      workspace: string;
      files: WorkspaceMemoryEntry[];
    }
  | { type: "finishList"; workspace: string }
  | { type: "selectFile"; filename: string | null }
  | {
      type: "setDetail";
      detail: WorkspaceMemoryDetail | null;
      workspace?: string;
    }
  | { type: "setMemoryIndex"; workspace: string; value: string }
  | { type: "setShowIndex"; show: boolean }
  | { type: "setExpandedFileKeys"; keys: string[] };

function createWorkspaceMemoryState(
  workspace: string | null | undefined
): WorkspaceMemoryState {
  return {
    workspace,
    files: [],
    selectedFile: null,
    detail: null,
    memoryIndex: "",
    loading: Boolean(workspace),
    showIndex: false,
    expandedFileKeys: [],
  };
}

export function reduceWorkspaceMemoryState(
  state: WorkspaceMemoryState,
  action: WorkspaceMemoryAction
): WorkspaceMemoryState {
  switch (action.type) {
    case "resetWorkspace":
      return createWorkspaceMemoryState(action.workspace);
    case "beginList":
      return state.workspace === action.workspace
        ? { ...state, loading: true }
        : state;
    case "receiveFiles":
      return state.workspace === action.workspace
        ? { ...state, files: action.files }
        : state;
    case "finishList":
      return state.workspace === action.workspace
        ? { ...state, loading: false }
        : state;
    case "selectFile":
      return { ...state, selectedFile: action.filename };
    case "setDetail":
      return action.workspace === undefined ||
        state.workspace === action.workspace
        ? { ...state, detail: action.detail }
        : state;
    case "setMemoryIndex":
      return state.workspace === action.workspace
        ? { ...state, memoryIndex: action.value }
        : state;
    case "setShowIndex":
      return { ...state, showIndex: action.show };
    case "setExpandedFileKeys":
      return { ...state, expandedFileKeys: action.keys };
  }
}

export function useWorkspaceMemoryData({
  workspace,
  searchQuery,
  sortKey,
  typeFilter,
  onRefreshStatus,
}: UseWorkspaceMemoryDataOptions): UseWorkspaceMemoryDataReturn {
  const { t } = useTranslation("settings");
  const mountedRef = useMounted();

  const [memoryState, dispatch] = useReducer(
    reduceWorkspaceMemoryState,
    workspace,
    createWorkspaceMemoryState
  );
  const nextMemoryState =
    memoryState.workspace === workspace
      ? memoryState
      : createWorkspaceMemoryState(workspace);
  if (nextMemoryState !== memoryState) {
    dispatch({ type: "resetWorkspace", workspace });
  }
  const {
    files,
    selectedFile,
    detail,
    memoryIndex,
    loading,
    showIndex,
    expandedFileKeys,
  } = nextMemoryState;

  const setSelectedFile = useCallback((filename: string | null) => {
    dispatch({ type: "selectFile", filename });
  }, []);
  const setDetail = useCallback((nextDetail: WorkspaceMemoryDetail | null) => {
    dispatch({ type: "setDetail", detail: nextDetail });
  }, []);
  const setShowIndex = useCallback((show: boolean) => {
    dispatch({ type: "setShowIndex", show });
  }, []);
  const setExpandedFileKeys = useCallback((keys: string[]) => {
    dispatch({ type: "setExpandedFileKeys", keys });
  }, []);

  const requestFiles = useCallback(() => {
    if (!workspace) return;
    const requestWorkspace = workspace;
    rpc.workspaceMemory
      .list({ workspace: requestWorkspace })
      .then((entries: WorkspaceMemoryEntry[]) => {
        if (mountedRef.current) {
          dispatch({
            type: "receiveFiles",
            workspace: requestWorkspace,
            files: entries,
          });
        }
      })
      .catch(() => {
        if (mountedRef.current)
          Message.error(t("indexing.workspaceMemoryListFailed"));
      })
      .finally(() => {
        if (mountedRef.current) {
          dispatch({ type: "finishList", workspace: requestWorkspace });
        }
      });
  }, [workspace, mountedRef, t]);

  const fetchFiles = useCallback(() => {
    if (!workspace) return;
    dispatch({ type: "beginList", workspace });
    requestFiles();
  }, [requestFiles, workspace]);

  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    fetchFiles,
    loading
  );

  useEffect(() => {
    requestFiles();
  }, [requestFiles]);

  const loadFileDetail = useCallback(
    (filename: string) => {
      if (!workspace) return;
      const requestWorkspace = workspace;
      setDetail(null);
      rpc.workspaceMemory
        .read({ workspace: requestWorkspace, filename })
        .then((detailResult: WorkspaceMemoryDetail) => {
          if (mountedRef.current) {
            dispatch({
              type: "setDetail",
              workspace: requestWorkspace,
              detail: detailResult,
            });
          }
        })
        .catch(() => {
          if (mountedRef.current)
            Message.error(t("indexing.workspaceMemoryReadFailed"));
        });
    },
    [workspace, mountedRef, setDetail, t]
  );

  const setSingleExpandedFile = useCallback(
    (entry: WorkspaceMemoryEntry) => {
      const { filename } = entry;
      const shouldOpen = !expandedFileKeys.includes(filename);
      setExpandedFileKeys(shouldOpen ? [filename] : []);
      if (shouldOpen) {
        setSelectedFile(filename);
        setShowIndex(false);
        loadFileDetail(filename);
      } else {
        setSelectedFile(null);
        setDetail(null);
      }
    },
    [
      expandedFileKeys,
      loadFileDetail,
      setDetail,
      setExpandedFileKeys,
      setSelectedFile,
      setShowIndex,
    ]
  );

  const handleShowIndex = useCallback(() => {
    if (!workspace) return;
    setSelectedFile(null);
    setDetail(null);
    setExpandedFileKeys([]);
    setShowIndex(true);
    rpc.workspaceMemory
      .index({ workspace })
      .then((indexText: string) => {
        if (mountedRef.current) {
          dispatch({ type: "setMemoryIndex", workspace, value: indexText });
        }
      })
      .catch(() => {
        if (mountedRef.current)
          Message.error(t("indexing.workspaceMemoryIndexFailed"));
      });
  }, [
    workspace,
    mountedRef,
    setDetail,
    setExpandedFileKeys,
    setSelectedFile,
    setShowIndex,
    t,
  ]);

  const handleDelete = useCallback(
    (filename: string) => {
      if (!workspace) return;
      void ask(t("indexing.workspaceMemoryDeleteConfirm", { filename }), {
        kind: "warning",
      }).then((confirmed) => {
        if (!confirmed) return;
        rpc.workspaceMemory
          .delete({ workspace, filename })
          .then(() => {
            if (!mountedRef.current) return;
            if (selectedFile === filename) {
              setSelectedFile(null);
              setDetail(null);
              setExpandedFileKeys([]);
            }
            fetchFiles();
            onRefreshStatus();
          })
          .catch(() => {
            Message.error(t("indexing.workspaceMemoryDeleteFailed"));
          });
      });
    },
    [
      workspace,
      mountedRef,
      selectedFile,
      fetchFiles,
      onRefreshStatus,
      setDetail,
      setExpandedFileKeys,
      setSelectedFile,
      t,
    ]
  );

  const handleClearAll = useCallback(() => {
    if (!workspace) return;
    if (files.length === 0) return;
    void ask(
      t("indexing.workspaceMemoryClearConfirm", { count: files.length }),
      { kind: "warning" }
    ).then((confirmed) => {
      if (!confirmed) return;
      rpc.workspaceMemory
        .clear({ workspace })
        .then((removedCount: number) => {
          if (!mountedRef.current) return;
          setSelectedFile(null);
          setDetail(null);
          setShowIndex(false);
          setExpandedFileKeys([]);
          fetchFiles();
          onRefreshStatus();
          Message.success(
            t("indexing.workspaceMemoryClearedCount", { count: removedCount })
          );
        })
        .catch(() => {
          Message.error(t("indexing.workspaceMemoryClearFailed"));
        });
    });
  }, [
    workspace,
    files.length,
    mountedRef,
    fetchFiles,
    onRefreshStatus,
    setDetail,
    setExpandedFileKeys,
    setSelectedFile,
    setShowIndex,
    t,
  ]);

  const filteredFiles = useMemo(() => {
    let result = files;
    if (typeFilter !== MEMORY_TYPE_FILTER_ALL) {
      result = result.filter((entry) => entry.memoryType === typeFilter);
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (entry) =>
          entry.filename.toLowerCase().includes(query) ||
          (entry.description?.toLowerCase().includes(query) ?? false)
      );
    }
    const sorted = [...result];
    sorted.sort((entryA, entryB) => {
      if (sortKey === MEMORY_SORT_NAME) {
        return entryA.filename.localeCompare(entryB.filename);
      }
      if (sortKey === MEMORY_SORT_TYPE) {
        const typeA = entryA.memoryType ?? "";
        const typeB = entryB.memoryType ?? "";
        const typeCompare = typeA.localeCompare(typeB);
        if (typeCompare !== 0) return typeCompare;
        return entryA.filename.localeCompare(entryB.filename);
      }
      if (sortKey === MEMORY_SORT_OLDEST) {
        return entryA.mtimeMs - entryB.mtimeMs;
      }
      return entryB.mtimeMs - entryA.mtimeMs;
    });
    return sorted;
  }, [files, typeFilter, searchQuery, sortKey]);

  return {
    files,
    filteredFiles,
    selectedFile,
    detail,
    loading,
    showIndex,
    memoryIndex,
    expandedFileKeys,
    spinClass,
    handleRefreshClick,
    handleShowIndex,
    handleDelete,
    handleClearAll,
    setSingleExpandedFile,
    loadFileDetail,
    setExpandedFileKeys,
    setSelectedFile,
    setDetail,
    setShowIndex,
    fetchFiles,
  };
}
