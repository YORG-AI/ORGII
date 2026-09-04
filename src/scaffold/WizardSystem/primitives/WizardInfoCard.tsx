/**
 * WizardInfoCard Component
 *
 * Summary / status card used inside wizard steps.
 * Uses DETAIL_PANEL_TOKENS.cardInfo for consistent styling.
 *
 * @example
 * ```tsx
 * <WizardInfoCard className="mb-4">
 *   <div className="text-sm font-medium text-text-1">Server name</div>
 *   <div className="text-xs text-text-3">npx @mcp/server</div>
 * </WizardInfoCard>
 * ```
 */
import React from "react";

import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

interface WizardInfoCardProps {
  children: React.ReactNode;
  className?: string;
}

const WizardInfoCard: React.FC<WizardInfoCardProps> = ({
  children,
  className,
}) => {
  const classes = className
    ? `${DETAIL_PANEL_TOKENS.cardInfo} ${className}`
    : DETAIL_PANEL_TOKENS.cardInfo;

  return <div className={classes}>{children}</div>;
};

export default WizardInfoCard;
