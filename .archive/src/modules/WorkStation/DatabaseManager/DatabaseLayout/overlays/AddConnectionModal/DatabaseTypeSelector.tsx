import { memo } from "react";
import { useTranslation } from "react-i18next";

import type { DatabaseType } from "@src/engines/DatabaseCore";

import type { DatabaseTypeOption } from "./databaseTypeOptions";

export interface DatabaseTypeSelectorProps {
  options: DatabaseTypeOption[];
  selectedType: DatabaseType;
  onSelectType: (type: DatabaseType) => void;
}

export const DatabaseTypeSelector = memo(function DatabaseTypeSelector({
  options,
  selectedType,
  onSelectType,
}: DatabaseTypeSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className="mb-4">
      <label className="mb-2 block text-xs font-medium text-text-2">
        {t("database.databaseType")}
      </label>
      <div className="scrollbar-overlay grid max-h-[200px] grid-cols-3 gap-2 overflow-y-auto">
        {options.map((option) => (
          <button
            key={option.type}
            type="button"
            onClick={() => onSelectType(option.type)}
            className={`flex flex-col items-center gap-1 rounded-lg border p-3 transition-all ${
              selectedType === option.type
                ? "border-primary-6 bg-primary-6/10 text-primary-6"
                : "border-border-2 bg-bg-1 text-text-2 hover:border-border-1 hover:bg-fill-3"
            }`}
          >
            {option.icon}
            <span className="text-xs font-medium">{option.name}</span>
            <span className="text-[10px] text-text-4">
              {t(option.descriptionKey)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
});
