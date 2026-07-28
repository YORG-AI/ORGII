/**
 * ActionCard Component
 *
 * Canonical selectable card used across Code Accounts, Wizards, and Model selection.
 * Supports multiple variants, icons (Lucide or custom elements), and selection state.
 *
 * For selection card tokens (use in custom layouts), import from config:
 *   import { SELECTION_CARD_CLASSES, getSelectionCardClass } from "@src/components/ActionCard/config";
 *
 * @example
 * ```tsx
 * import ActionCard from "@src/components/ActionCard";
 * import { Search, Zap } from "lucide-react";
 *
 * // With Lucide icon (clickable card)
 * <ActionCard
 *   title="Auto-detect"
 *   description="Find API key from local config files"
 *   onClick={handleDetect}
 *   variant="primary"
 *   icon={Search}
 * />
 *
 * // With tooltip (info icon inside card)
 * <ActionCard
 *   title="Timer"
 *   tooltip="Fire at a fixed interval"
 *   onClick={() => onSelect("timer")}
 *   icon={Timer}
 *   showSelect
 *   selected={selected === "timer"}
 * />
 * ```
 */
import cn from "classnames";
import { ArrowRight, Check, Info } from "lucide-react";
import React from "react";

import Button from "@src/components/Button";
import Tooltip from "@src/components/Tooltip";

import { VARIANT_STYLES } from "./config";
import type { ActionCardProps } from "./types";

const CheckboxIndicator: React.FC<{ selected: boolean }> = ({ selected }) => (
  <span
    className={cn(
      "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded",
      selected
        ? "border-primary-6 bg-primary-6"
        : "border border-text-4 bg-transparent"
    )}
  >
    {selected && <Check size={10} className="text-white" />}
  </span>
);

const RadioIndicator: React.FC<{ selected: boolean }> = ({ selected }) => (
  <span
    className={cn(
      "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border",
      selected ? "border-primary-6" : "border-text-4"
    )}
  >
    {selected && <span className="h-2 w-2 rounded-full bg-primary-6" />}
  </span>
);

const InfoTooltip: React.FC<{ content: string }> = ({ content }) => (
  <Tooltip content={content} showArrow={false} position="top">
    <span
      className="flex-shrink-0 cursor-help text-text-3 hover:text-text-2"
      onClick={(event) => event.stopPropagation()}
    >
      <Info size={14} />
    </span>
  </Tooltip>
);

const ActionCard: React.FC<ActionCardProps> = ({
  title,
  description,
  onClick,
  variant = "default",
  icon: Icon,
  iconElement,
  iconPreserveColor = false,
  buttonText,
  buttonLoading = false,
  disabled = false,
  showSelect = false,
  showSelectionCheck = true,
  showCheckbox = false,
  showRadio = false,
  selected = false,
  showArrow = false,
  tooltip,
  badge,
  dataTestId,
  compact = false,
  className = "",
}) => {
  const variantConfig = VARIANT_STYLES[variant];

  const hasSelector = showSelect || showCheckbox || showRadio;
  const isSelected = hasSelector && selected;
  const hasButton = Boolean(buttonText);

  const handleCardClick = () => {
    if (disabled || hasButton) return;
    onClick();
  };

  const handleButtonClick = () => {
    if (disabled) return;
    onClick();
  };

  const containerClass = cn(
    showArrow && "group",
    isSelected
      ? variantConfig.selectedContainerClass
      : variantConfig.containerClass,
    !hasButton && variantConfig.containerHoverClass,
    disabled && "opacity-50 cursor-not-allowed",
    compact && "py-1.5",
    className
  );

  const iconColorClass =
    isSelected && !iconPreserveColor
      ? variantConfig.selectedIconClass
      : variantConfig.iconClass;

  const titleClass = isSelected
    ? variantConfig.selectedTitleClass
    : variantConfig.titleClass;

  const showTrailingCheck =
    showSelect && showSelectionCheck && !showCheckbox && !showRadio && selected;

  const content = (
    <>
      <div className="flex items-center gap-2">
        {showCheckbox && !showRadio && (
          <CheckboxIndicator selected={selected} />
        )}
        {showRadio && <RadioIndicator selected={selected} />}

        {iconElement ? (
          <div className={cn("flex-shrink-0", iconColorClass)}>
            {iconElement}
          </div>
        ) : Icon ? (
          <Icon size={16} className={iconColorClass} />
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className={titleClass}>{title}</p>
            {badge && (
              <span className="inline-flex flex-shrink-0 items-center rounded-full bg-primary-1 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-6">
                {badge}
              </span>
            )}
          </div>
          {description && (
            <p className={variantConfig.descriptionClass}>{description}</p>
          )}
        </div>

        {tooltip && !isSelected && <InfoTooltip content={tooltip} />}

        {hasButton && (
          <Button
            variant={variant === "primary" ? "primary" : "secondary"}
            size="small"
            onClick={handleButtonClick}
            disabled={disabled}
            loading={buttonLoading}
          >
            {buttonText}
          </Button>
        )}

        {showTrailingCheck &&
          (tooltip ? (
            <Tooltip content={tooltip} showArrow={false} position="top">
              <span className="flex-shrink-0 cursor-help">
                <Check size={14} className="text-primary-6" />
              </span>
            </Tooltip>
          ) : (
            <Check size={14} className="flex-shrink-0 text-primary-6" />
          ))}

        {showArrow && (
          <ArrowRight
            size={14}
            className="invisible flex-shrink-0 text-text-1 group-hover:visible group-active:visible"
          />
        )}
      </div>
    </>
  );

  // A clickable card is an interactive control, not a generic div. Native
  // button semantics make every wizard/selection surface keyboard reachable
  // (Tab + Enter/Space) and expose the control to assistive technology. Cards
  // with their own trailing Button remain a non-interactive container to avoid
  // invalid nested buttons; only that explicit action performs the callback.
  if (hasButton) {
    return (
      <div className={containerClass} data-testid={dataTestId}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6 focus-visible:ring-offset-2",
        containerClass
      )}
      onClick={handleCardClick}
      disabled={disabled}
      aria-pressed={hasSelector ? selected : undefined}
      data-testid={dataTestId}
    >
      {content}
    </button>
  );
};

export default ActionCard;
export { SELECTION_CARD_CLASSES, getSelectionCardClass } from "./config";
export type { ActionCardProps, ActionCardVariant } from "./types";
