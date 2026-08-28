/**
 * CherryPickCheckbox Component
 *
 * A checkbox for selecting individual lines in cherry-picking mode
 */
import React from "react";

import { HugeiconsIcon, Tick01Icon } from "@src/icons";

interface CherryPickCheckboxProps {
  checked: boolean;
  lineType: "add" | "remove" | "context" | "empty";
  onClick: () => void;
}

export const CherryPickCheckbox: React.FC<CherryPickCheckboxProps> = ({
  checked,
  lineType,
  onClick,
}) => {
  // Don't show checkbox for context or empty lines
  if (lineType === "context" || lineType === "empty") {
    return <div className="cherry-pick-checkbox cherry-pick-checkbox-empty" />;
  }

  const getUncheckedColor = () => {
    if (lineType === "add") return "cherry-pick-checkbox-add";
    if (lineType === "remove") return "cherry-pick-checkbox-remove";
    return "";
  };

  return (
    <div
      className={`cherry-pick-checkbox ${
        checked ? "cherry-pick-checkbox-checked" : getUncheckedColor()
      }`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {checked && (
        <HugeiconsIcon
          icon={Tick01Icon}
          data-icon="check"
          size={14}
          strokeWidth={2.5}
        />
      )}
    </div>
  );
};
