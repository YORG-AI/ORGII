import React from "react";
import { useTranslation } from "react-i18next";

import { SpotlightTabs } from "../../components/SpotlightTabs";

export type BranchPickerTab = "branches" | "prs";

export function BranchPickerTabs({
  value,
  onChange,
  disabled = false,
}: {
  value: BranchPickerTab;
  onChange: (tab: BranchPickerTab) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SpotlightTabs
      shortcut="ctrlTab"
      ariaLabel={`${t("selectors.branch.tabs.branches")} / ${t("selectors.branch.tabs.prs")}`}
      dataTestId="branch-picker-tabs"
      value={value}
      options={[
        {
          value: "branches",
          label: t("selectors.branch.tabs.branches"),
          disabled,
        },
        { value: "prs", label: t("selectors.branch.tabs.prs"), disabled },
      ]}
      onChange={onChange}
    />
  );
}
