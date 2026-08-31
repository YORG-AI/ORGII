/**
 * LoadingView Component
 *
 * Displays loading state with spinner and optional unsaved changes bar.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import {
  FileHeader,
  TabBarBottomPanelToggle,
  UnsavedChangesBar,
} from "@src/modules/WorkStation/shared";

import type { LoadingViewProps } from "../types";

export const LoadingView: React.FC<LoadingViewProps> = ({
  relativePath,
  repoPath,
  hasUnsavedChanges,
  isPreviewable,
  isPreviewMode,
  saving,
  onFileSelect,
  onReload,
  onTogglePreview,
  onSave,
  onDiscard,
}) => {
  const { t } = useTranslation();

  return (
    <>
      <FileHeader
        publishToHost="code"
        filePath={relativePath}
        repoPath={repoPath}
        onFileSelect={onFileSelect}
        onReload={onReload}
        loading={true}
        hasUnsavedChanges={hasUnsavedChanges}
        isMarkdownFile={isPreviewable}
        isPreviewMode={isPreviewMode}
        onTogglePreview={onTogglePreview}
        beforeMoreMenuSlot={<TabBarBottomPanelToggle />}
      />
      <div className="relative flex flex-1 flex-col">
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("placeholders.loadingFile")}
          fillParentHeight
        />
        {hasUnsavedChanges && (
          <UnsavedChangesBar
            saving={saving}
            onSave={onSave}
            onDiscard={onDiscard}
          />
        )}
      </div>
    </>
  );
};

export default LoadingView;
