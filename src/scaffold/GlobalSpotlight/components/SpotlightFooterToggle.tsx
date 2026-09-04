/**
 * SpotlightFooterToggle Component
 *
 * Checkbox control rendered inside the keyboard-hint pill, after a thin
 * separator, for palette-level view preferences (e.g. "Show path"). It
 * borrows the pill's own type scale and muted color so it reads as part
 * of the hint strip rather than a button bolted onto it.
 *
 * Reaches the pill through `<ShellFooterAction placement="inline">`.
 */
import React from "react";

import Checkbox from "@src/components/Checkbox";

interface SpotlightFooterToggleProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const SpotlightFooterToggle: React.FC<SpotlightFooterToggleProps> = ({
  label,
  checked,
  onCheckedChange,
}) => {
  return (
    <span className="flex items-center gap-4">
      <span aria-hidden className="h-3 w-px shrink-0 bg-border-2" />
      <Checkbox
        size="mini"
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        className="gap-1.5! text-[11px]! text-text-2 transition-colors hover:text-text-1"
      >
        {label}
      </Checkbox>
    </span>
  );
};

export default SpotlightFooterToggle;
