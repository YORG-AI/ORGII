/**
 * ModelChipPicker — multi-select chip list over registered models.
 *
 * Lists models from currently configured KeyVault accounts; users can
 * add or remove chips but cannot type unregistered model IDs. Used for
 * Reliability Fallback Models in the SDE Agent config.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import ModelIcon from "@src/components/ModelIcon";
import Select, { type SelectOptionGroup } from "@src/components/Select";
import {
  buildAccountLookup,
  getRustCompatibleAccounts,
  useAgentCompatibility,
  useModelAccountLookup,
} from "@src/hooks/models";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";
import { formatModelNameFull } from "@src/util/formatModelName";

interface ModelChipPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
}

const ModelChipPicker: React.FC<ModelChipPickerProps> = ({
  value,
  onChange,
  placeholder,
  className,
}) => {
  const { t } = useTranslation("settings");
  const { accounts: allAccounts } = useModelAccountLookup();
  const { registry } = useAgentCompatibility();

  const accounts = useMemo(
    () => getRustCompatibleAccounts(registry, allAccounts),
    [registry, allAccounts]
  );

  const accountLookup = useMemo(() => buildAccountLookup(accounts), [accounts]);

  const optionGroups = useMemo<SelectOptionGroup[]>(() => {
    const options = Array.from(accountLookup.entries())
      .filter(([modelId]) => !value.includes(modelId))
      .sort(([idA], [idB]) => idA.localeCompare(idB))
      .map(([modelId]) => {
        const label = (
          <span className="flex items-center gap-2">
            <ModelIcon modelName={modelId} size="small" />
            <span className="truncate">{formatModelNameFull(modelId)}</span>
          </span>
        );
        return { value: modelId, label, triggerLabel: label };
      });
    return [{ label: "", options }];
  }, [accountLookup, value]);

  const handleAdd = (modelId: string) => {
    if (!modelId) return;
    if (value.includes(modelId)) return;
    onChange([...value, modelId]);
  };

  const handleRemove = (modelId: string) => {
    onChange(value.filter((item) => item !== modelId));
  };

  return (
    <div className={`flex flex-col gap-2 ${className ?? ""}`}>
      <div className="flex flex-wrap gap-1.5">
        {value.map((modelId) => (
          <span
            key={modelId}
            className="inline-flex items-center gap-1.5 rounded-md bg-fill-2 px-2 py-1 text-xs text-text-1"
          >
            <ModelIcon modelName={modelId} size="small" />
            <span className="max-w-[180px] truncate">
              {formatModelNameFull(modelId)}
            </span>
            <button
              type="button"
              onClick={() => handleRemove(modelId)}
              className="text-text-3 hover:text-text-1"
              title={t("common:actions.remove")}
            >
              <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={12} />
            </button>
          </span>
        ))}
        {value.length === 0 && (
          <span className="text-xs text-text-3">
            {t("sharedAgentConfig.reliability.fallbackModelsEmpty")}
          </span>
        )}
      </div>
      <Select
        value={undefined}
        options={optionGroups}
        onChange={(val) => handleAdd(String(val))}
        placeholder={
          placeholder ?? t("sharedAgentConfig.reliability.fallbackModelsAdd")
        }
        showSearch
        size="default"
        className="w-full"
      />
    </div>
  );
};

export default ModelChipPicker;
