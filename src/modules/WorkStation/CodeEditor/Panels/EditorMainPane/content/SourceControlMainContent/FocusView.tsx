/**
 * FocusView
 *
 * Single-file working-tree diff for the unified Source Control tab.
 */
import React, { Suspense, memo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { NoTabsPlaceholder } from "@src/modules/WorkStation/shared";
import type { GitFile } from "@src/types/git/types";

const GitDiffContent = React.lazy(() => import("../GitDiffContent"));

const LazyFallback: React.FC = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

export interface FocusViewProps {
  /** Selected file's git diff record (resolved by the renderer) */
  gitFile: GitFile | null;
  /** Whether focusPath is set but its diff hasn't loaded yet */
  loading: boolean;
  /** Repository path for relative path display */
  repoPath?: string;
  /** Whether a focus path is currently selected */
  hasFocus: boolean;
  /** Reload current diff */
  onReload?: () => void;
  /** Open the file as a regular file tab */
  onFileSelect?: (path: string) => void;
  /** Clear the focused file and return to the empty Focus state. */
  onClose?: () => void;
  /** Sync local edit state to tab bar dot */
  onUnsavedChange?: (hasUnsaved: boolean) => void;
  /** Render the file breadcrumb inside the main pane instead of the workstation header. */
  inlineFileHeader?: boolean;
}

const FocusView: React.FC<FocusViewProps> = ({
  gitFile,
  loading,
  repoPath,
  hasFocus,
  onReload,
  onFileSelect,
  onClose,
  onUnsavedChange,
  inlineFileHeader = true,
}) => {
  const { t } = useTranslation();
  const emptyPlaceholder = (
    <NoTabsPlaceholder
      icon="source-control"
      caption={t("placeholders.selectFileToViewChanges")}
    />
  );

  if (!hasFocus) {
    return emptyPlaceholder;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <Suspense fallback={<LazyFallback />}>
        <GitDiffContent
          gitFile={gitFile}
          loading={loading}
          repoPath={repoPath}
          onReload={onReload}
          onFileSelect={onFileSelect}
          onClose={onClose}
          onUnsavedChange={onUnsavedChange}
          publishHeaderToWorkstation={!inlineFileHeader}
          emptyState={emptyPlaceholder}
        />
      </Suspense>
    </div>
  );
};

export default memo(FocusView);
