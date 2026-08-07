import { memo } from "react";
import { useTranslation } from "react-i18next";

import { ADD_CONNECTION_TEXT_INPUT_CLASS } from "./formInputClass";

export interface NeonConnectionFieldsProps {
  neonConnString: string;
  onNeonConnStringChange: (value: string) => void;
}

export const NeonConnectionFields = memo(function NeonConnectionFields({
  neonConnString,
  onNeonConnStringChange,
}: NeonConnectionFieldsProps) {
  const { t } = useTranslation();

  return (
    <div className="mb-4">
      <label className="mb-1 block text-xs font-medium text-text-2">
        {t("database.connectionString")}
      </label>
      <input
        type="text"
        value={neonConnString}
        onChange={(event) => onNeonConnStringChange(event.target.value)}
        placeholder="postgres://user:pass@ep-xxx.neon.tech/dbname"
        className={ADD_CONNECTION_TEXT_INPUT_CLASS}
      />
      <p className="mt-1 text-[10px] text-text-4">{t("database.neonHint")}</p>
    </div>
  );
});
