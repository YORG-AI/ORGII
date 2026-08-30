/**
 * CollapsibleSection
 *
 * Reusable collapsible section with chevron toggle.
 * Used in detail panels for Code Accounts, Channels, Memory Browser, etc.
 */
import React from "react";

import { COLLAPSIBLE_SECTION_TOKENS } from "@src/config/detailPanelTokens";
import { useCollapsible } from "@src/hooks/ui/useCollapsible";
import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

export interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  /** Optional right-aligned content in the header row (e.g. TabPill, badge) */
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Optional additional class for the wrapper */
  className?: string;
  /** When true, removes the default mb-6 wrapper margin (parent controls spacing) */
  compact?: boolean;
  /** Merged after default header row classes */
  headerRowClassName?: string;
  /** Merged after default title button classes */
  titleButtonClassName?: string;
  /** Class on the title label (wrapped in a span) */
  titleClassName?: string;
  /** Wraps the chevron (e.g. h-7 w-7 box to align with list row icons) */
  chevronContainerClassName?: string;
  /** Override chevron icon size (px) */
  chevronSize?: number;
  /** Override chevron stroke width */
  chevronStrokeWidth?: number;
  /** Override chevron color class */
  chevronClassName?: string;
  /** Optional data-testid on the header toggle button */
  titleButtonTestId?: string;
  /**
   * Called whenever the section toggles open/closed. Lets parents react
   * to visibility changes — e.g. start/stop polling expensive data
   * (LSP server logs) only while the section is open.
   */
  onOpenChange?: (open: boolean) => void;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  defaultOpen = true,
  actions,
  children,
  className = "",
  compact = false,
  headerRowClassName = "",
  titleButtonClassName = "",
  titleClassName = "",
  chevronContainerClassName,
  chevronSize: chevronSizeProp,
  chevronStrokeWidth: chevronStrokeWidthProp,
  chevronClassName: chevronClassNameProp,
  titleButtonTestId,
  onOpenChange,
}) => {
  const { isOpen, toggle: toggleOpen } = useCollapsible({
    defaultOpen,
    onOpenChange,
  });

  const wrapperClass = compact ? "" : COLLAPSIBLE_SECTION_TOKENS.wrapper;

  const chevronSize = chevronSizeProp ?? COLLAPSIBLE_SECTION_TOKENS.chevronSize;
  const chevronClass =
    chevronClassNameProp ?? COLLAPSIBLE_SECTION_TOKENS.chevronClass;
  const chevronStrokeWidth = chevronStrokeWidthProp ?? 2;

  const chevronIcon = isOpen ? (
    <HugeiconsIcon
      icon={ArrowDown01Icon}
      data-icon="chevron-down"
      size={chevronSize}
      strokeWidth={chevronStrokeWidth}
      className={chevronClass}
    />
  ) : (
    <HugeiconsIcon
      icon={ArrowRight01Icon}
      data-icon="chevron-right"
      size={chevronSize}
      strokeWidth={chevronStrokeWidth}
      className={chevronClass}
    />
  );

  const chevronNode = chevronContainerClassName ? (
    <span className={chevronContainerClassName}>{chevronIcon}</span>
  ) : (
    chevronIcon
  );

  return (
    <div className={`${wrapperClass} ${className}`.trim()}>
      <div
        className={`${COLLAPSIBLE_SECTION_TOKENS.headerRow} ${headerRowClassName}`.trim()}
      >
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={isOpen}
          data-testid={titleButtonTestId}
          className={`${COLLAPSIBLE_SECTION_TOKENS.titleButton} ${titleButtonClassName}`.trim()}
        >
          {chevronNode}
          <span className={titleClassName || undefined}>{title}</span>
        </button>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {isOpen && children}
    </div>
  );
};

export default CollapsibleSection;
