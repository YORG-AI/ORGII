import { SECTION_CONTROL_STYLE } from "@/src/modules/shared/layouts/SectionLayout";
import React from "react";
import { useTranslation } from "react-i18next";

import NumberInput from "@src/components/NumberInput";
import Select from "@src/components/Select";
import Slider from "@src/components/Slider";
import Switch from "@src/components/Switch";
import type { SettingsFieldRow } from "@src/config/settingsUiManifest/types";
import { useSetting } from "@src/store/settings";

interface SettingsFieldRendererProps {
  row: SettingsFieldRow;
}

const SettingsFieldRenderer: React.FC<SettingsFieldRendererProps> = ({
  row,
}) => {
  const { t } = useTranslation("settings");
  const [value, setValue] = useSetting(row.key);

  if (row.controlType === "switch") {
    return (
      <Switch
        checked={Boolean(value)}
        onCheckedChange={(checked) => setValue(checked as never)}
      />
    );
  }

  if (row.controlType === "select") {
    const options =
      row.options?.map((option) => ({
        value: option.value,
        label: option.labelKey ? t(option.labelKey) : (option.label ?? ""),
      })) ?? [];

    return (
      <Select
        value={value as string | number}
        onChange={(nextValue) => setValue(nextValue as never)}
        options={options}
        size="default"
        style={SECTION_CONTROL_STYLE}
      />
    );
  }

  if (row.controlType === "number") {
    return (
      <NumberInput
        value={typeof value === "number" ? value : 0}
        onValueChange={(nextValue) => {
          if (nextValue !== undefined) {
            setValue(nextValue as never);
          }
        }}
        min={row.min}
        max={row.max}
        step={row.step}
        controlsPosition="sides"
        style={SECTION_CONTROL_STYLE}
      />
    );
  }

  if (row.controlType === "slider") {
    const sliderMin = row.min ?? 0;
    const sliderMax = row.max ?? 100;
    const sliderNoPadding = row.noPadding ?? true;
    return (
      <div className="w-[160px] max-w-full">
        <Slider
          value={typeof value === "number" ? value : 0}
          onValueChange={(nextValue) => {
            const resolvedValue = Array.isArray(nextValue)
              ? nextValue[0]
              : nextValue;
            setValue(resolvedValue as never);
          }}
          min={sliderMin}
          max={sliderMax}
          showTooltip={false}
          noPadding={sliderNoPadding}
        />
      </div>
    );
  }

  return null;
};

export default SettingsFieldRenderer;
