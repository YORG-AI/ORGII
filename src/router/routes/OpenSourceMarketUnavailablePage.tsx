import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";

/**
 * Stand-in for Token Market, Agent Market, and Service Market routes in the
 * open-source product build. Routes stay registered; the full marketplace UI
 * is not shipped in OSS.
 */
const OpenSourceMarketUnavailablePage: React.FC = () => {
  const { t } = useTranslation("market");

  return (
    <div className="box-border flex h-full min-h-0 w-full flex-col">
      <div className="min-h-0 flex-1">
        <Placeholder
          variant="empty"
          placement="detail-panel"
          fillParentHeight
          title={t("openSourceMarket.title")}
          subtitle={t("openSourceMarket.subtitle")}
        />
      </div>
    </div>
  );
};

export default OpenSourceMarketUnavailablePage;
