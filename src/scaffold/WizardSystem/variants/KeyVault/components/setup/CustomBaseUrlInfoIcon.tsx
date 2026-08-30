import { useTranslation } from "react-i18next";

import Tooltip from "@src/components/Tooltip";
import { HugeiconsIcon, InformationCircleIcon } from "@src/icons";

export function CustomBaseUrlInfoIcon() {
  const { t } = useTranslation("integrations");

  return (
    <Tooltip
      content={
        <div className="flex max-w-[280px] flex-col gap-1">
          <span className="font-medium">
            {t("keyVault.customBaseUrlNoteTitle")}
          </span>
          <span>{t("keyVault.customBaseUrlNoteBody")}</span>
        </div>
      }
      position="top"
      mouseEnterDelay={200}
    >
      <span className="inline-flex shrink-0 cursor-help text-text-3 hover:text-text-2">
        <HugeiconsIcon
          icon={InformationCircleIcon}
          data-icon="info"
          size={14}
        />
      </span>
    </Tooltip>
  );
}
