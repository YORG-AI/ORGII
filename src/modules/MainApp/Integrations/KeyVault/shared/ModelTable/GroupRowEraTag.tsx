/** Generation-era tag used by the Key Vault ModelTable. */
import React from "react";
import { useTranslation } from "react-i18next";

import Tag from "@src/components/Tag";

import { GROUP_ROW_ERA_TAG_COLOR, type GroupRowEra } from "./config";

export interface GroupRowEraTagProps {
  era: GroupRowEra;
}

/**
 * Compact era label on model group rows (latest generation vs older lineups).
 */
const GroupRowEraTag: React.FC<GroupRowEraTagProps> = ({ era }) => {
  const { t } = useTranslation("integrations");

  const labelKey =
    era === "current"
      ? "modelsTable.groupTagCurrent"
      : "modelsTable.groupTagNonCurrent";

  return (
    <Tag
      size="mini"
      pill
      color={GROUP_ROW_ERA_TAG_COLOR[era]}
      className="shrink-0"
    >
      {t(labelKey)}
    </Tag>
  );
};

export default GroupRowEraTag;
