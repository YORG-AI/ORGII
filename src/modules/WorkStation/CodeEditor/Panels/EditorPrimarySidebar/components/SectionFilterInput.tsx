import { Funnel } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import { PANEL_CONSTANTS } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/config";

// ─── Filter Input Row ─────────────────────────────────────────────────────────

export interface SectionFilterInputProps {
  query: string;
  onChange: (q: string) => void;
  onClose: () => void;
  placeholder?: string;
}

export const SectionFilterInput: React.FC<SectionFilterInputProps> = ({
  query,
  onChange,
  onClose,
  placeholder,
}) => {
  const { t } = useTranslation("common");

  return (
    <div className="flex-shrink-0 px-3 pb-2 pt-1">
      <Input
        prefix={<Funnel size={14} strokeWidth={1.75} />}
        placeholder={placeholder ?? t("actions.filter", "Filter")}
        value={query}
        onChange={(value) => onChange(value)}
        size="small"
        className="input-pane-surface"
        autoFocus
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape") {
            onClose();
          }
        }}
      />
    </div>
  );
};

// ─── Section Header Action Factory ───────────────────────────────────────────

export interface MakeSectionFilterActionOptions {
  /** Unique key for the action */
  key: string;
  isOpen: boolean;
  hasQuery: boolean;
  onToggle: () => void;
  tooltip?: string;
}

/** Returns a `SectionHeaderAction` for the filter toggle button */
export function makeSectionFilterAction({
  key,
  isOpen,
  hasQuery,
  onToggle,
  tooltip = "Filter",
}: MakeSectionFilterActionOptions): SectionHeaderAction {
  return {
    key,
    icon: (
      <Funnel
        size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
        strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
        className={isOpen ? "text-primary-6" : ""}
      />
    ),
    tooltip,
    onClick: onToggle,
    forceVisible: isOpen || hasQuery,
  };
}
