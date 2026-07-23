import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import TabPill from "@src/components/TabPill";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
} from "@src/modules/shared/layouts/blocks";

import ComputerUseConfig from "./BuiltInTools/Preview/DesktopToolConfig";

const ComputerUseCategoryView: React.FC = () => {
  const { t } = useTranslation("integrations");
  const tabs = useMemo(
    () => [{ key: "desktop", label: t("builtInTools.tabDesktopControl") }],
    [t]
  );

  return (
    <DetailPanelContainer>
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <TabPill
            tabs={tabs}
            activeTab="desktop"
            onChange={() => {}}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
      />
      <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div
          className={`${DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop} flex flex-col gap-3`}
        >
          <ComputerUseConfig />
        </div>
      </div>
    </DetailPanelContainer>
  );
};

export default ComputerUseCategoryView;
