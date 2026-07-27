/**
 * AllChangesView
 *
 * Aggregated diff list of every working-tree (or staged) file. Lifted out of
 * the old `GitAllChangesContent` component so it can be reused both inside
 * the unified Source Control tab (under the All Changes pill) and by
 * MessageViewer's chat-side preview.
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

import { DiffSectionList } from "@src/modules/WorkStation/shared";
import { sourceControlFocusTargetAtom } from "@src/store/workstation/codeEditor";
import type { GitFile } from "@src/types/git/types";

import { useAllChangesFiles } from "./allChanges/useAllChangesFiles";

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
}

const AllChangesView: React.FC<AllChangesViewProps> = ({
  files,
  loading,
  staged,
  repoId,
  repoPath,
  onFileSelect,
  collapseAllSignal,
}) => {
  const { t } = useTranslation();
  const focusTarget = useAtomValue(sourceControlFocusTargetAtom);

  const {
    sortedFiles,
    loadContentForFile,
    releaseContentForFile,
    getSectionRef,
  } = useAllChangesFiles({ files, repoId, repoPath });

  const previousCollapseAllSignalRef = useRef(collapseAllSignal);
  const lastScrolledFocusNonceRef = useRef<number | null>(null);
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
      showRenamePath
      hideBottomPadding
    />
  );
};

export default memo(AllChangesView);
