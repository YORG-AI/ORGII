import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";

const ComingSoonRoutePage: React.FC = () => {
  const { t } = useTranslation(["common", "navigation"]);

  return (
    <Placeholder
      variant="empty"
      placement="detail-panel"
      fillParentHeight
      title={t("navigation:routes.ideaArea")}
      subtitle={t("common:actions.comingSoon")}
    />
  );
};

export default ComingSoonRoutePage;
