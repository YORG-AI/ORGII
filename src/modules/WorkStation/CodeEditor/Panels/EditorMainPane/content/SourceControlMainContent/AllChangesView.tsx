/**
 * AllChangesView
 *
 * Aggregated diff list of every working-tree (or staged) file. Lifted out of
 * the old `GitAllChangesContent` component so it can be reused both inside
 * the unified Source Control tab (under the All Changes pill) and by
 * MessageViewer's chat-side preview.
 *
 * The view is unmounted whenever Source Control stops being the active tab
 * and rebuilt on the next visit. Its list view state (expanded sections,
 * scroll offset, handled focus request) is saved per tab through
 * `viewStateKey` so the rebuild lands where the user left off instead of
 * collapsing every file and scrolling back to the top.
 */
import { useAtomValue } from "jotai";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  DiffSectionList,
  type DiffSectionListViewState,
} from "@src/modules/WorkStation/shared";
import {
  diffViewModeAtom,
  sourceControlFocusTargetAtom,
} from "@src/store/workstation/codeEditor";
import {
  getTabViewState,
  setTabViewState,
} from "@src/store/workstation/tabs/tabViewState";
import type { GitFile } from "@src/types/git/types";

import { useAllChangesFiles } from "./allChanges/useAllChangesFiles";

/** Slot under the owning tab's view state that holds the list snapshot. */
export const ALL_CHANGES_VIEW_STATE_SLOT = "allChanges";

export interface AllChangesViewProps {
  /** All git files to display */
  files: GitFile[];
  /** Loading state */
  loading: boolean;
  /** Whether showing staged changes */
  staged: boolean;
  /** Repository id for Git API requests */
  repoId?: string;
  /** Repository path - used to display relative paths */
  repoPath?: string;
  /** Open a file in its own diff tab */
  onFileSelect?: (path: string) => void;
  /** Monotonic signal from the global header collapse-all action. */
  collapseAllSignal?: number;
  /**
   * Tab id whose view state carries this list across remounts. Omit for
   * embedded previews that should always start fresh.
   */
  viewStateKey?: string;
}

const AllChangesView: React.FC<AllChangesViewProps> = ({
  files,
  loading,
  staged,
  repoId,
  repoPath,
  onFileSelect,
  collapseAllSignal,
  viewStateKey,
}) => {
  const { t } = useTranslation();
  const focusTarget = useAtomValue(sourceControlFocusTargetAtom);
  const viewMode = useAtomValue(diffViewModeAtom);

  const {
    sortedFiles,
    loadContentForFile,
    releaseContentForFile,
    getSectionRef,
  } = useAllChangesFiles({ files, repoId, repoPath });

  // Read once per mount; the list rebuilds itself from this snapshot.
  const [restoredViewState] = useState<DiffSectionListViewState | null>(() =>
    viewStateKey
      ? (getTabViewState<DiffSectionListViewState>(
          viewStateKey,
          ALL_CHANGES_VIEW_STATE_SLOT
        ) ?? null)
      : null
  );
  const handleViewStateChange = useCallback(
    (viewState: DiffSectionListViewState) => {
      if (!viewStateKey) return;
      setTabViewState(viewStateKey, ALL_CHANGES_VIEW_STATE_SLOT, viewState);
    },
    [viewStateKey]
  );

  const previousCollapseAllSignalRef = useRef(collapseAllSignal);
  // Seeded from the snapshot so a remount for the same focus request does
  // not scroll back to the focused file over the restored offset.
  const lastScrolledFocusNonceRef = useRef<number | null>(
    restoredViewState?.focusNonce ?? null
  );
  const filesKey = files
    .map((file) =>
      JSON.stringify([
        file.path,
        file.original_path ?? "",
        file.status,
        file.staged,
        file.repoRoot ?? "",
      ])
    )
    .sort()
    .join("|");

  const [collapseTrigger, setCollapseTrigger] = useState(0);

  useEffect(() => {
    queueMicrotask(() => setCollapseTrigger(0));
  }, [filesKey]);

  useEffect(() => {
    if (previousCollapseAllSignalRef.current === collapseAllSignal) return;
    previousCollapseAllSignalRef.current = collapseAllSignal;
    queueMicrotask(() => setCollapseTrigger((prev) => prev + 1));
  }, [collapseAllSignal]);

  const focusedFile = sortedFiles.find((file) => {
    if (!focusTarget) return false;
    const absolutePath = file.path.startsWith("/")
      ? file.path
      : repoPath
        ? `${repoPath}/${file.path}`
        : file.path;
    return absolutePath === focusTarget.path || file.path === focusTarget.path;
  });

  useEffect(() => {
    if (!focusTarget || !focusedFile) return;
    loadContentForFile(focusedFile);

    if (lastScrolledFocusNonceRef.current === focusTarget.nonce) return;
    lastScrolledFocusNonceRef.current = focusTarget.nonce;

    const frame = window.requestAnimationFrame(() => {
      const targetRef = getSectionRef(focusedFile.path);
      targetRef?.current?.scrollIntoView({
        block: "start",
        behavior: "auto",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [focusedFile, focusTarget, getSectionRef, loadContentForFile]);

  const handleRequestContent = useCallback(
    (file: GitFile) => {
      void loadContentForFile(file);
    },
    [loadContentForFile]
  );

  const handleExpansionChange = useCallback(
    (file: GitFile, expanded: boolean) => {
      if (!expanded) releaseContentForFile(file.path);
    },
    [releaseContentForFile]
  );

  const sections = useMemo(
    () => sortedFiles.map((file) => ({ key: file.id, file })),
    [sortedFiles]
  );

  return (
    <DiffSectionList
      sections={sections}
      viewMode={viewMode}
      loading={loading}
      emptyTitle={
        staged ? t("placeholders.noStagedChanges") : t("placeholders.noChanges")
      }
      repoPath={repoPath}
      defaultCollapsed
      collapseSignal={collapseTrigger}
      getSectionRef={getSectionRef}
      focusedPath={focusedFile?.path ?? null}
      focusedNonce={focusTarget?.nonce ?? 0}
      onFileSelect={onFileSelect}
      onRequestContent={handleRequestContent}
      onExpansionChange={handleExpansionChange}
      viewState={restoredViewState}
      onViewStateChange={handleViewStateChange}
      showRenamePath
      compactHeaderGutter
      hideBottomPadding
    />
  );
};

export default memo(AllChangesView);
