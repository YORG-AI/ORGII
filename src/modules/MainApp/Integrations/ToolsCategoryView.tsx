/**
 * ToolsCategoryView — dev-only Built-in Tools content pane.
 *
 * This module is lazy-loaded only after the guarded `tools` route opens, so
 * its metadata/config hooks never mount in ordinary Settings usage.
 */
import { useSetAtom } from "jotai";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import TabPill from "@src/components/TabPill";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
} from "@src/modules/shared/layouts/blocks";
import { integrationsToolbarAtom } from "@src/store/ui/integrationsToolbarAtom";

import { BuiltInToolsTable } from "./BuiltInTools/Table/BuiltInToolsTable";
import { useAgentToolMatrix } from "./BuiltInTools/useAgentToolMatrix";
import { useBuiltInTools } from "./BuiltInTools/useBuiltInTools";
import { ToolEventPreview } from "./DevTools/ToolEventPreview";

const ToolsCategoryView: React.FC = () => {
  const { t } = useTranslation("integrations");
  type BuiltinTab = "table" | "playground";
  const [builtinTab, setBuiltinTab] = useState<BuiltinTab>("table");
  const tools = useBuiltInTools();
  const agentMatrix = useAgentToolMatrix();
  const setToolbarEntry = useSetAtom(integrationsToolbarAtom);
  const { refresh, toolsListLoading } = tools;

  useEffect(() => {
    setToolbarEntry((current) => ({
      ...current,
      onRefresh: refresh,
      loading: toolsListLoading,
    }));
  }, [refresh, setToolbarEntry, toolsListLoading]);

  useEffect(() => {
    return () => {
      setToolbarEntry((current) =>
        current.onRefresh === refresh
          ? { extraButtons: current.extraButtons }
          : current
      );
    };
  }, [refresh, setToolbarEntry]);

  const builtinTabs = useMemo(
    () => [
      { key: "table", label: t("builtInTools.tabTools") },
      { key: "playground", label: t("toolsArea.devtools") },
    ],
    [t]
  );

  const builtinHeader = (
    <InternalHeader
      noPanelHeader
      contentPadding
      className={DETAIL_PANEL_TOKENS.headerWidth}
      tabs={
        <TabPill
          tabs={builtinTabs}
          activeTab={builtinTab}
          onChange={(key) => setBuiltinTab(key as BuiltinTab)}
          variant="simple"
          fillWidth={false}
          size="large"
        />
      }
    />
  );

  if (builtinTab === "playground") {
    return (
      <DetailPanelContainer>
        {builtinHeader}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
          <div
            className={`${DETAIL_PANEL_TOKENS.contentWidth} flex min-h-0 flex-1 flex-col`}
          >
            <ToolEventPreview />
          </div>
        </div>
      </DetailPanelContainer>
    );
  }

  return (
    <DetailPanelContainer>
      {builtinHeader}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <BuiltInToolsTable tools={tools} agentMatrix={agentMatrix} />
      </div>
    </DetailPanelContainer>
  );
};

export default ToolsCategoryView;
