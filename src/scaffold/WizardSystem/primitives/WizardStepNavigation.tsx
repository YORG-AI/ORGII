/**
 * WizardStepNavigation
 *
 * Shared vertical step navigation for wizards that expose their full setup
 * path. Flow ownership stays with the caller; this component only projects
 * active, completed, and locked state into the canonical navigation UI.
 */
import React, { type AriaAttributes, type ComponentType, memo } from "react";

import completedIcon from "@src/assets/fileTypeIcons/todo.svg";
import { createRepositoryAssetIcon } from "@src/components/RepositoryAssetIcon";
import { HEADER_ICON_SIZE, TYPOGRAPHY } from "@src/config/workstation/tokens";

interface WizardStepIconProps {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  "aria-hidden"?: AriaAttributes["aria-hidden"];
}

type WizardStepIcon = ComponentType<WizardStepIconProps>;

const CompletedStepIcon = createRepositoryAssetIcon(
  completedIcon,
  "CompletedStepIcon"
);

const WIZARD_STEP_NAVIGATION_TOKENS = {
  list: "scrollbar-overlay flex flex-1 flex-col overflow-y-auto",
  item: "relative pb-1",
  button:
    "group flex w-full items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors duration-150",
  buttonActive: "bg-sidebar-selected",
  buttonEnabled: "cursor-pointer bg-transparent hover:bg-fill-2",
  buttonDisabled: "cursor-not-allowed bg-transparent opacity-45",
  icon: "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors",
  iconActive: "border-text-1 bg-text-1 text-bg-1",
  iconCompleted: "border-border-2 bg-bg-2 text-text-1",
  iconPending: "border-border-2 bg-bg-2 text-text-3",
  title: `block truncate ${TYPOGRAPHY.contentTitle}`,
  description: `mt-0.5 block truncate text-text-3 ${TYPOGRAPHY.contentSubtitle}`,
  iconSize: HEADER_ICON_SIZE.sm,
} as const;

interface WizardStepNavigationItem<T extends string = string> {
  id: T;
  title: string;
  description: string;
  icon: WizardStepIcon;
  completed: boolean;
  disabled?: boolean;
}

interface WizardStepNavigationProps<T extends string = string> {
  items: WizardStepNavigationItem<T>[];
  activeId: T;
  onSelect: (id: T) => void | Promise<void>;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  testIdPrefix?: string;
}

function WizardStepNavigationComponent<T extends string = string>({
  items,
  activeId,
  onSelect,
  ariaLabel,
  disabled = false,
  className = "",
  testIdPrefix = "wizard-step",
}: WizardStepNavigationProps<T>) {
  return (
    <nav
      className={`${WIZARD_STEP_NAVIGATION_TOKENS.list} ${className}`.trim()}
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const StepIcon = item.icon;
        const isActive = item.id === activeId;
        const isDisabled = disabled || item.disabled === true;

        return (
          <div key={item.id} className={WIZARD_STEP_NAVIGATION_TOKENS.item}>
            <button
              className={`${WIZARD_STEP_NAVIGATION_TOKENS.button} ${
                isActive
                  ? WIZARD_STEP_NAVIGATION_TOKENS.buttonActive
                  : isDisabled
                    ? WIZARD_STEP_NAVIGATION_TOKENS.buttonDisabled
                    : WIZARD_STEP_NAVIGATION_TOKENS.buttonEnabled
              }`}
              onClick={() => void onSelect(item.id)}
              disabled={isDisabled}
              aria-current={isActive ? "step" : undefined}
              type="button"
              data-testid={`${testIdPrefix}-${item.id}`}
            >
              <span
                className={`${WIZARD_STEP_NAVIGATION_TOKENS.icon} ${
                  isActive
                    ? WIZARD_STEP_NAVIGATION_TOKENS.iconActive
                    : item.completed
                      ? WIZARD_STEP_NAVIGATION_TOKENS.iconCompleted
                      : WIZARD_STEP_NAVIGATION_TOKENS.iconPending
                }`}
                aria-hidden
              >
                {item.completed ? (
                  <CompletedStepIcon
                    size={WIZARD_STEP_NAVIGATION_TOKENS.iconSize}
                  />
                ) : (
                  <StepIcon size={WIZARD_STEP_NAVIGATION_TOKENS.iconSize} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`${WIZARD_STEP_NAVIGATION_TOKENS.title} ${
                    isActive ? "text-text-1" : "text-text-2"
                  }`}
                >
                  {item.title}
                </span>
                <span className={WIZARD_STEP_NAVIGATION_TOKENS.description}>
                  {item.description}
                </span>
              </span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}

const WizardStepNavigation = memo(
  WizardStepNavigationComponent
) as typeof WizardStepNavigationComponent;

export default WizardStepNavigation;
