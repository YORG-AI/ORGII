/**
 * PanelFooter — reusable sticky footer bar for panels.
 *
 * Mirrors PanelHeader: border-t, 48px height, left content + right actions.
 * Supports multiple layouts via composition:
 *
 * ```tsx
 * // Simple: single primary action (replaces PanelFooterAction)
 * <PanelFooter
 *   primaryAction={{ label: "Import (3)", icon: <Download />, onClick: handleImport }}
 * />
 *
 * // Left info + right action
 * <PanelFooter
 *   left={<span className="text-xs text-text-3">3 selected</span>}
 *   primaryAction={{ label: "Import", onClick: handleImport }}
 * />
 *
 * // Multi-select bar (workItems style)
 * <PanelFooter
 *   left={<>
 *     <Button variant="secondary" size="small" onClick={selectAll}>Select All</Button>
 *     <Button variant="secondary" size="small" onClick={clear}>Clear</Button>
 *     <span className="text-xs text-text-3">5 selected</span>
 *   </>}
 *   primaryAction={{ label: "Import (5)", icon: <Download />, onClick: handleImport }}
 * />
 * ```
 */
import React from "react";

import Button from "@src/components/Button";
import type { ButtonAppearance, ButtonVariant } from "@src/components/Button";

export const PANEL_FOOTER_TOKENS = {
  /** Footer height (px) */
  height: 48,
  /** Footer height class */
  heightClass: "h-12",
  /** Horizontal padding (px) */
  paddingX: 16,
  /** Horizontal padding class */
  paddingXClass: "px-4",
  /** Item gap (px) */
  gap: 8,
  /** Item gap class */
  gapClass: "gap-2",
  /** Top border class */
  borderClass: "border-t border-border-2",
  /** Complete footer container with border */
  container:
    "flex h-12 shrink-0 items-center gap-2 px-4 border-t border-border-2",
  /** Complete footer container without border */
  containerNoBorder: "flex h-12 shrink-0 items-center gap-2 px-4",
  /** Left slot classes */
  leftSlot: "flex min-w-0 flex-1 items-center gap-2",
  /** Spacer when no left slot exists */
  spacer: "flex-1",
} as const;

export interface PanelFooterAction {
  label: string;
  onClick?: () => void;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  iconOnly?: boolean;
  title?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Importance / semantic role. */
  variant?: ButtonVariant;
  /** Visual treatment. Omit to use the variant's default. */
  appearance?: ButtonAppearance;
  htmlType?: "button" | "submit";
  href?: string;
  target?: string;
  dataTestId?: string;
}

export interface PanelFooterProps {
  /** Primary action button on the right */
  primaryAction?: PanelFooterAction;
  /** Additional action buttons to the left of the primary (rendered right-side) */
  secondaryActions?: PanelFooterAction[];
  /** Secondary action button size: small=28px, default=32px */
  secondaryButtonSize?: "small" | "default";
  /** Primary action button size: small=28px, default=32px */
  primaryButtonSize?: "small" | "default";
  /** Left-side content (info text, selection controls, stats) */
  left?: React.ReactNode;
  /** Additional className */
  className?: string;
  /** Hide top border */
  noBorder?: boolean;
}

const PrimaryActionButton: React.FC<{
  action: PanelFooterAction;
  size: "small" | "default";
}> = ({ action, size }) => (
  <Button
    variant={action.variant ?? "primary"}
    appearance={action.appearance}
    size={size}
    icon={action.icon}
    iconPosition={action.iconPosition}
    iconOnly={action.iconOnly}
    title={action.title}
    disabled={action.disabled}
    loading={action.loading}
    htmlType={action.htmlType}
    href={action.href}
    target={action.target}
    data-testid={action.dataTestId}
    onClick={action.onClick}
  >
    {action.label}
  </Button>
);

const PanelFooter: React.FC<PanelFooterProps> = ({
  primaryAction,
  secondaryActions,
  secondaryButtonSize = "small",
  primaryButtonSize = "small",
  left,
  className = "",
  noBorder = false,
}) => {
  const containerClass = noBorder
    ? PANEL_FOOTER_TOKENS.containerNoBorder
    : PANEL_FOOTER_TOKENS.container;

  return (
    <div className={`${containerClass} ${className}`}>
      {left && <div className={PANEL_FOOTER_TOKENS.leftSlot}>{left}</div>}

      {!left && <div className={PANEL_FOOTER_TOKENS.spacer} />}

      {secondaryActions?.map((action) => (
        <Button
          key={action.label}
          variant={action.variant ?? "secondary"}
          appearance={action.appearance}
          size={secondaryButtonSize}
          icon={action.icon}
          iconPosition={action.iconPosition}
          iconOnly={action.iconOnly}
          title={action.title}
          disabled={action.disabled}
          loading={action.loading}
          htmlType={action.htmlType}
          href={action.href}
          target={action.target}
          data-testid={action.dataTestId}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ))}

      {primaryAction && (
        <PrimaryActionButton action={primaryAction} size={primaryButtonSize} />
      )}
    </div>
  );
};

export default PanelFooter;
