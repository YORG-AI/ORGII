/**
 * Reusable collapsible section title for compact dropdown panels.
 */
import React, { memo } from "react";

import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import { classNames } from "@src/util/ui/classNames";

import { DROPDOWN_CLASSES, DROPDOWN_ITEM } from "./tokens";

export interface DropdownCollapsibleSectionHeaderProps {
  children: React.ReactNode;
  className?: string;
  expanded: boolean;
  onToggle: () => void;
}

const DropdownCollapsibleSectionHeader: React.FC<DropdownCollapsibleSectionHeaderProps> =
  memo(({ children, className, expanded, onToggle }) => (
    <button
      type="button"
      className={classNames(
        DROPDOWN_CLASSES.sectionLabel,
        "flex w-full cursor-pointer items-center gap-1 text-left hover:text-text-2",
        className
      )}
      onClick={onToggle}
      aria-expanded={expanded}
      data-dropdown-keyboard-skip="true"
    >
      <span className="min-w-0 truncate">{children}</span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        data-icon="chevron-right"
        size={DROPDOWN_ITEM.iconSize}
        className={classNames(
          "shrink-0 transition-transform duration-150",
          expanded ? "rotate-90" : ""
        )}
        aria-hidden
      />
    </button>
  ));

DropdownCollapsibleSectionHeader.displayName =
  "DropdownCollapsibleSectionHeader";

export default DropdownCollapsibleSectionHeader;
