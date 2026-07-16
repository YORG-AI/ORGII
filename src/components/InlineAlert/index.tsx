/**
 * InlineAlert — Shared inline alert/result card component.
 *
 * Outline-only treatment: a 1px border in the type's accent color with no
 * background fill, so alerts don't compete visually with surrounding
 * sections that already have their own surface color.
 *
 * Padding (p-3), icon size 14. Header row: icon + title + optional action + close;
 * body (children) and subtitle render below the header.
 * When action is an object, InlineAlert builds a secondary Button at 28px height.
 */
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";
import React from "react";

import Button from "@src/components/Button";

const STYLE_MAP = {
  danger: {
    border: "border-danger-3",
    text: "text-danger-6",
  },
  success: {
    border: "border-success-3",
    text: "text-success-6",
  },
  warning: {
    border: "border-warning-3",
    text: "text-warning-6",
  },
  info: {
    border: "border-primary-3",
    text: "text-primary-6",
  },
} as const;

const DEFAULT_ICONS: Record<string, React.ReactNode> = {
  success: <Check size={14} className="flex-shrink-0" />,
  danger: <TriangleAlert size={14} className="flex-shrink-0" />,
  warning: <TriangleAlert size={14} className="flex-shrink-0" />,
  info: <Info size={14} className="flex-shrink-0" />,
};

const INLINE_ALERT_TOKENS = {
  titleText: "block text-[13px] font-medium leading-[14px]",
  bodyText: "text-[12px] font-normal leading-snug",
  subtitleText: "mt-1 block text-[11px] opacity-70",
} as const;

export interface InlineAlertActionConfig {
  label: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
}

function isActionConfig(
  action: InlineAlertActionConfig | React.ReactNode
): action is InlineAlertActionConfig {
  return (
    typeof action === "object" &&
    action !== null &&
    "label" in action &&
    typeof (action as unknown as Record<string, unknown>).label === "string"
  );
}

export interface InlineAlertProps {
  /** "success" | "danger" | "warning" | "info" */
  type: "success" | "danger" | "warning" | "info";
  /** Body text (below the header row) */
  children?: React.ReactNode;
  /** Title in the header row (same row as icon, action, close) */
  title?: string;
  /** Optional icon override — defaults to Check/TriangleAlert/AlertCircle/Info per type */
  icon?: React.ReactNode;
  /** Hide the icon entirely */
  hideIcon?: boolean;
  /** Optional subtitle below the body */
  subtitle?: React.ReactNode;
  /** Extra className on the outer container */
  className?: string;
  /** Compact expandable pill that shows only title until expanded */
  presentation?: "default" | "pill";
  /** Optional action — object builds a 28px secondary Button; ReactNode for custom */
  action?: InlineAlertActionConfig | React.ReactNode;
  /** Show a close icon button when provided */
  onClose?: () => void;
  /** Optional close icon override */
  closeIcon?: React.ReactNode;
  /** Accessible label for close button */
  closeAriaLabel?: string;
}

const InlineAlert: React.FC<InlineAlertProps> = ({
  type,
  children,
  title,
  icon,
  hideIcon = false,
  subtitle,
  className,
  presentation = "default",
  action,
  onClose,
  closeIcon,
  closeAriaLabel = "Close",
}) => {
  const styles = STYLE_MAP[type];
  const [expanded, setExpanded] = React.useState(presentation !== "pill");
  const isPill = presentation === "pill";
  const showContent = !isPill || expanded;
  const resolvedIcon =
    icon ??
    (isPill ? (
      expanded ? (
        <ChevronsDownUp size={14} className="flex-shrink-0" />
      ) : (
        <ChevronsUpDown size={14} className="flex-shrink-0" />
      )
    ) : (
      DEFAULT_ICONS[type]
    ));
  const resolvedCloseIcon = closeIcon ?? (
    <X size={14} className="flex-shrink-0" />
  );
  const hasTitle = Boolean(title);

  const actionNode =
    action &&
    (isActionConfig(action) ? (
      <Button
        variant="secondary"
        size="small"
        href={action.href}
        target={action.href ? "_blank" : undefined}
        rel={action.href ? "noopener noreferrer" : undefined}
        onClick={action.onClick}
        disabled={action.disabled}
        icon={action.icon}
        iconPosition={action.iconPosition}
      >
        {action.label}
      </Button>
    ) : (
      (action as React.ReactNode)
    ));

  const titleNode = (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {!hideIcon && (
        <span className="flex h-[14px] shrink-0 items-center">
          {resolvedIcon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {hasTitle ? (
          <span className={INLINE_ALERT_TOKENS.titleText}>{title}</span>
        ) : (
          showContent &&
          children && (
            <span className={`block ${INLINE_ALERT_TOKENS.bodyText}`}>
              {children}
            </span>
          )
        )}
      </div>
    </div>
  );

  return (
    <div
      className={`border border-solid ${styles.border} ${isPill ? `inline-block w-fit max-w-full ${expanded ? "rounded-lg" : "rounded-full"} px-3 py-2` : "rounded-lg p-3"} ${styles.text} ${className ?? ""}`}
    >
      <div className={`flex items-center ${isPill ? "gap-1" : "gap-3"}`}>
        {isPill ? (
          <button
            type="button"
            onClick={() => setExpanded((currentExpanded) => !currentExpanded)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center text-left"
          >
            {titleNode}
          </button>
        ) : (
          titleNode
        )}
        {action && <div className="shrink-0">{actionNode}</div>}
        {onClose && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onClose}
              aria-label={closeAriaLabel}
              className="shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
            >
              {resolvedCloseIcon}
            </button>
          </div>
        )}
      </div>
      {showContent && hasTitle && children && (
        <div className={`mt-2 ${INLINE_ALERT_TOKENS.bodyText}`}>{children}</div>
      )}
      {showContent && subtitle && (
        <span className={INLINE_ALERT_TOKENS.subtitleText}>{subtitle}</span>
      )}
    </div>
  );
};

export default InlineAlert;
