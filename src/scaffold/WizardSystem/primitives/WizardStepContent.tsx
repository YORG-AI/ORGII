/**
 * WizardStepContent
 *
 * Shared semantic content frame for an individual wizard step. It owns the
 * heading hierarchy, optional leading icon, supporting copy, content width,
 * and vertical rhythm so wizard variants do not rebuild them locally.
 */
import type { LucideIcon } from "lucide-react";
import React, { memo, useId } from "react";

import { HEADER_ICON_SIZE, TYPOGRAPHY } from "@src/config/workstation/tokens";
import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

export const WIZARD_STEP_CONTENT_TOKENS = {
  container: `${DETAIL_PANEL_TOKENS.contentWidth} ${SECTION_GAP_CLASSES}`,
  header: "flex items-start gap-3",
  icon: "mt-1 shrink-0 text-text-3",
  iconSize: HEADER_ICON_SIZE.md,
  title: `m-0 leading-5 tracking-tight text-text-1 ${TYPOGRAPHY.contentTitle}`,
  description: `m-0 mt-1 max-w-2xl leading-5 text-text-3 ${TYPOGRAPHY.contentSubtitle}`,
  body: SECTION_GAP_CLASSES,
} as const;

export interface WizardStepContentProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children?: React.ReactNode;
  className?: string;
}

const WizardStepContent: React.FC<WizardStepContentProps> = memo(
  ({ title, description, icon: Icon, children, className = "" }) => {
    const titleId = useId();

    return (
      <section
        className={`${WIZARD_STEP_CONTENT_TOKENS.container} ${className}`.trim()}
        aria-labelledby={titleId}
      >
        <header className={WIZARD_STEP_CONTENT_TOKENS.header}>
          {Icon && (
            <Icon
              size={WIZARD_STEP_CONTENT_TOKENS.iconSize}
              strokeWidth={1.7}
              className={WIZARD_STEP_CONTENT_TOKENS.icon}
              aria-hidden
            />
          )}
          <div className="min-w-0">
            <h1 id={titleId} className={WIZARD_STEP_CONTENT_TOKENS.title}>
              {title}
            </h1>
            {description && (
              <p className={WIZARD_STEP_CONTENT_TOKENS.description}>
                {description}
              </p>
            )}
          </div>
        </header>
        <div className={WIZARD_STEP_CONTENT_TOKENS.body}>{children}</div>
      </section>
    );
  }
);

WizardStepContent.displayName = "WizardStepContent";

export default WizardStepContent;
