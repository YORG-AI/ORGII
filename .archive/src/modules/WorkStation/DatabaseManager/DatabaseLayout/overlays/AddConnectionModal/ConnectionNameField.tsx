import { memo } from "react";
import { useTranslation } from "react-i18next";

import { ADD_CONNECTION_TEXT_INPUT_CLASS } from "./formInputClass";

export interface ConnectionNameFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export const ConnectionNameField = memo(function ConnectionNameField({
  value,
  onChange,
}: ConnectionNameFieldProps) {
  const { t } = useTranslation();

  return (
    <div className="mb-4">
      <label className="mb-1 block text-xs font-medium text-text-2">
        {t("database.connectionName")}
      </label>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("placeholders.myDatabase")}
        className={ADD_CONNECTION_TEXT_INPUT_CLASS}
      />
    </div>
  );
});
