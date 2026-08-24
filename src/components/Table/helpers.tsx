import React from "react";

import Checkbox from "@src/components/Checkbox";

export const SortIcon: React.FC<{
  size?: number;
  sorted?: false | "asc" | "desc";
}> = ({ size = 16, sorted = false }) => {
  const highlight = "var(--color-primary-6)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d="m3 8 4-4 4 4"
        stroke={sorted === "asc" ? highlight : undefined}
      />
      <path d="M7 4v16" stroke={sorted === "asc" ? highlight : undefined} />
      <path
        d="m21 16-4 4-4-4"
        stroke={sorted === "desc" ? highlight : undefined}
      />
      <path d="M17 20V4" stroke={sorted === "desc" ? highlight : undefined} />
    </svg>
  );
};

interface IndeterminateCheckboxProps {
  checked: boolean;
  indeterminate: boolean;
  onChange: (event: unknown) => void;
}

export const IndeterminateCheckbox: React.FC<IndeterminateCheckboxProps> = ({
  checked,
  indeterminate,
  onChange,
}) => {
  return (
    <Checkbox
      checked={checked}
      indeterminate={indeterminate}
      onCheckedChange={(_checked, event) => onChange(event)}
      className="table-checkbox"
    />
  );
};
