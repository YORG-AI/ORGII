import React from "react";
import { useTranslation } from "react-i18next";

import SegmentedTextPill from "@src/components/SegmentedTextPill";

export type MarkdownEditorMode = "write" | "preview";

export interface MarkdownEditorModeSwitchProps {
  mode: MarkdownEditorMode;
  onModeChange: (mode: MarkdownEditorMode) => void;
  disabled?: boolean;
  dataTestId?: string;
  className?: string;
}

/** Compact Write/Preview control shared by Markdown composer action rows. */
export const MarkdownEditorModeSwitch: React.FC<
  MarkdownEditorModeSwitchProps
> = ({ mode, onModeChange, disabled = false, dataTestId, className }) => {
  const { t } = useTranslation("sessions");

  return (
    <SegmentedTextPill
      ariaLabel={t("creator.mode", "Editor mode")}
      className={className}
      dataTestId={dataTestId}
      value={mode}
      options={[
        {
          value: "write",
          label: t("common:actions.write", "Write"),
          disabled,
        },
        {
          value: "preview",
          label: t("common:common.preview", "Preview"),
          disabled,
        },
      ]}
      onChange={onModeChange}
    />
  );
};

export default MarkdownEditorModeSwitch;
