import { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";

import { ADD_CONNECTION_TEXT_INPUT_CLASS } from "./formInputClass";

export interface SqliteConnectionFieldsProps {
  filePath: string;
  onFilePathChange: (value: string) => void;
  onBrowseFile: () => void;
}

export const SqliteConnectionFields = memo(function SqliteConnectionFields({
  filePath,
  onFilePathChange,
  onBrowseFile,
}: SqliteConnectionFieldsProps) {
  const { t } = useTranslation();

  return (
    <div className="mb-4">
      <label className="mb-1 block text-xs font-medium text-text-2">
        {t("database.databaseFile")}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={filePath}
          onChange={(event) => onFilePathChange(event.target.value)}
          placeholder="/path/to/database.sqlite"
          className={`flex-1 ${ADD_CONNECTION_TEXT_INPUT_CLASS}`}
        />
        <Button onClick={onBrowseFile}>{t("actions.browse")}</Button>
      </div>
    </div>
  );
});
