/**
 * WizardProgressCard Component
 *
 * Spinner + message card for in-progress wizard states
 * (e.g. "Testing...", "Installing...").
 *
 * @example
 * ```tsx
 * <WizardProgressCard message="Testing connection..." />
 *
 * <WizardProgressCard>
 *   <div className="text-sm font-medium text-text-1">Downloading</div>
 *   <div className="text-xs text-text-3">Installing package…</div>
 * </WizardProgressCard>
 * ```
 */
import React from "react";

import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

export interface WizardProgressCardProps {
  /** Simple text message (renders as a single span) */
  message?: string;
  /** Rich content (overrides message) */
  children?: React.ReactNode;
  className?: string;
}

const WizardProgressCard: React.FC<WizardProgressCardProps> = ({
  message,
  children,
  className,
}) => {
  const baseClass = `${DETAIL_PANEL_TOKENS.cardInfo} flex items-center gap-3`;
  const classes = className ? `${baseClass} ${className}` : baseClass;

  return (
    <div className={classes}>
      <HugeiconsIcon
        icon={Loading03Icon}
        data-icon="loader-2"
        size={SPINNER_TOKENS.default}
        className="shrink-0 animate-spin text-primary-6"
      />
      {children ?? (
        <span className={`${TYPOGRAPHY.contentSubtitle} text-text-2`}>
          {message}
        </span>
      )}
    </div>
  );
};

export default WizardProgressCard;
