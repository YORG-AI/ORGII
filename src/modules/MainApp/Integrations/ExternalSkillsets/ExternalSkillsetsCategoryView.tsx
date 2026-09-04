/**
 * ExternalSkillsetsCategoryView — unified Skills, MCPs, Plugins surface.
 *
 * Top-level tabs replace the old per-category grouping:
 * Skills, MCP, Cursor Plugins.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import TabPill from "@src/components/TabPill";
import {
  type ExternalSkillsetsTab,
  extensionKindForSkillsetTab,
} from "@src/config/mainAppPaths";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
} from "@src/modules/shared/layouts/blocks";

import { McpCategoryView } from "../Mcp/McpCategoryView";
import type { McpCategoryTableProps } from "../Mcp/categoryTableProps";
import type { McpDetailState } from "../Mcp/types";
import { SkillsCategoryView } from "../Skills/SkillsCategoryView";
import type { SkillsCategoryTableProps } from "../Skills/categoryTableProps";
import type { SkillEditorState, SkillsHubDetailState } from "../Skills/types";
import CursorPluginsTab from "./CursorPluginsTab";

export interface ExternalSkillsetsCategoryViewProps {
  activeTab: ExternalSkillsetsTab;
  onTabChange: (tab: ExternalSkillsetsTab) => void;
  selectedExtensionId: string | null;
  mcp: McpDetailState;
  skillsHub: SkillsHubDetailState;
  skillEditor: SkillEditorState;
  mcpTableProps: McpCategoryTableProps;
  skillsTableProps: SkillsCategoryTableProps;
  fullPage: boolean;
  onBack: () => void;
  onEnterFullPage: () => void;
  onClosePreview: () => void;
}

export const ExternalSkillsetsCategoryView: React.FC<
  ExternalSkillsetsCategoryViewProps
> = ({
  activeTab,
  onTabChange,
  selectedExtensionId,
  mcp,
  skillsHub,
  skillEditor,
  mcpTableProps,
  skillsTableProps,
  fullPage,
  onBack,
  onEnterFullPage,
  onClosePreview,
}) => {
  const { t } = useTranslation("integrations");

  const tabs = useMemo(
    () => [
      { key: "skills" as const, label: t("externalSkillsets.tabs.skills") },
      { key: "mcp" as const, label: t("externalSkillsets.tabs.mcp") },
      {
        key: "cursor-plugins" as const,
        label: t("externalSkillsets.tabs.cursorPlugins"),
      },
    ],
    [t]
  );

  const extensionKind = extensionKindForSkillsetTab(activeTab);
  const wizardOpen = mcp.addMode || skillEditor.editorMode;

  const categoryContent = (() => {
    switch (extensionKind) {
      case "mcp":
        return (
          <McpCategoryView
            selectedId={selectedExtensionId}
            mcp={mcp}
            tableProps={{ ...mcpTableProps, embedded: true }}
            fullPage={fullPage}
            onBack={onBack}
            onExpand={fullPage ? undefined : onEnterFullPage}
            onClosePreview={onClosePreview}
          />
        );
      case "cursor-plugins":
        return <CursorPluginsTab />;
      default:
        return (
          <SkillsCategoryView
            selectedId={selectedExtensionId}
            skillsHub={skillsHub}
            skillEditor={skillEditor}
            tableProps={skillsTableProps}
            fullPage={fullPage}
            onBack={onBack}
            onExpand={fullPage ? undefined : onEnterFullPage}
            onClosePreview={onClosePreview}
            hideTabHeader
          />
        );
    }
  })();

  return (
    <DetailPanelContainer>
      {!wizardOpen && (
        <InternalHeader
          noPanelHeader
          contentPadding
          className={DETAIL_PANEL_TOKENS.headerWidth}
          tabs={
            <TabPill
              tabs={tabs}
              activeTab={activeTab}
              onChange={(key) => onTabChange(key as ExternalSkillsetsTab)}
              variant="simple"
              fillWidth={false}
              size="large"
            />
          }
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {categoryContent}
      </div>
    </DetailPanelContainer>
  );
};
