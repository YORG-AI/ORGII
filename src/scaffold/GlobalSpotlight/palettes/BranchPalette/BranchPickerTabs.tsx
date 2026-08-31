import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import SegmentedTextPill from "@src/components/SegmentedTextPill";

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
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (disabled || event.isComposing) return;
      const withinTabs =
        event.target instanceof Node &&
        containerRef.current?.contains(event.target);
      // Run before the picker's document-level row navigation: Enter on a
      // tab must activate that tab, not checkout the highlighted list row.
      if (withinTabs && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.target instanceof HTMLButtonElement) event.target.click();
      } else if (
        (event.ctrlKey && event.key === "Tab") ||
        (withinTabs &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight"))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onChange(value === "branches" ? "prs" : "branches");
      } else if (withinTabs && event.key === "Tab") {
        // Allow native focus traversal through the tabs and into search.
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [disabled, onChange, value]);
  return (
    <div ref={containerRef} className="contents">
      <SegmentedTextPill
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
    </div>
  );
}
