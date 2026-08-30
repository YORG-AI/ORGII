import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";

interface UnknownTabPlaceholderProps {
  type: string;
}

export const UnknownTabPlaceholder: React.FC<UnknownTabPlaceholderProps> = memo(
  ({ type: _type }) => {
    const { t } = useTranslation();
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={t("placeholders.unknownTabType")}
        fillParentHeight
      />
    );
  }
);

UnknownTabPlaceholder.displayName = "UnknownTabPlaceholder";

export default UnknownTabPlaceholder;
