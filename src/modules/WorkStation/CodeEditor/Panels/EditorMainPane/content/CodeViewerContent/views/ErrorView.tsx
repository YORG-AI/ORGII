/**
 * ErrorView Component
 *
 * Displays error states with specific UI for each error type:
 * - not_found: File not found
 * - permission: Permission denied
 * - too_large: File too large to display
 * - default: Generic error
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import {
  FileHeader,
  TabBarBottomPanelToggle,
} from "@src/modules/WorkStation/shared";

import type { ErrorViewProps } from "../types";

export const ErrorView: React.FC<ErrorViewProps> = ({
  relativePath,
  repoPath,
  selectedFile,
  error,
  hasUnsavedChanges,
  isPreviewable,
  isPreviewMode,
  onFileSelect,
  onReload,
  onTogglePreview,
}) => {
  const { t } = useTranslation();

  const { title, subtitle, onRetry } = useMemo(() => {
    switch (error.type) {
      case "not_found":
        return {
          title: t("placeholders.unableToLocateFile"),
          subtitle: t("placeholders.fileMayHaveBeenDeletedOrMoved"),
          onRetry: onReload,
        };
      case "permission":
        return {
          title: t("errors.forbidden"),
          subtitle: error.message,
          onRetry: undefined,
        };
      case "too_large":
        return {
          title: t("placeholders.fileTooLarge"),
          subtitle: `${error.message}\n${t("placeholders.considerOpeningExternalEditor")}\n${selectedFile}`,
          onRetry: undefined,
        };
      default:
        return {
          title: t("placeholders.errorLoadingFile"),
          subtitle: error.message,
          onRetry: onReload,
        };
    }
  }, [error, onReload, selectedFile, t]);

  return (
    <>
      <FileHeader
        publishToHost="code"
        filePath={relativePath}
        repoPath={repoPath}
        onFileSelect={onFileSelect}
        onReload={onReload}
        loading={false}
        hasUnsavedChanges={hasUnsavedChanges}
        isMarkdownFile={isPreviewable}
        isPreviewMode={isPreviewMode}
        onTogglePreview={onTogglePreview}
        beforeMoreMenuSlot={<TabBarBottomPanelToggle />}
      />
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={title}
        subtitle={subtitle}
        onRetry={onRetry}
        fillParentHeight
      />
    </>
  );
};

export default ErrorView;
