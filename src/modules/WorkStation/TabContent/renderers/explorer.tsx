/**
 * Renderer wrapper for `explorer` tabs.
 *
 * `explorer` is currently a marker tab type that the Code Editor host
 * treats as the default / empty state. There is no concrete component
 * to render — the host paints the explorer sidebar and the main pane
 * shows an empty placeholder. Phase 1b mirrors that semantics so the
 * registry remains exhaustive without inventing a new surface.
 */
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";

import type { UnifiedTabContentProps } from "../types";

const ExplorerTabRenderer: React.FC<UnifiedTabContentProps> = memo(() => {
  const { t } = useTranslation();
  const handleAddWorkspace = useCallback(() => {
    openWorkspaceSpotlight("switch");
  }, []);

  return (
    <Placeholder
      variant="empty"
      placement="detail-panel"
      title={t("placeholders.noWorkspaceExplorerTitle", {
        defaultValue: "No workspace open",
      })}
      subtitle={t("placeholders.noWorkspaceExplorerSubtitle", {
        defaultValue: "Open workspace to view file",
      })}
      action={{
        label: t("actions.openWorkspace", { defaultValue: "Open Workspace" }),
        onClick: handleAddWorkspace,
      }}
      fillParentHeight
    />
  );
});

ExplorerTabRenderer.displayName = "ExplorerTabRenderer";

export default ExplorerTabRenderer;
