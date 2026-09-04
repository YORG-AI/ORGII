/**
 * WizardStepContent
 *
 * Wizard adapter for the shared SectionHeading intro treatment. It supplies
 * the standard wizard content width and level-one heading contract so wizard
 * variants do not rebuild layout or semantic markup locally.
 */
import React, { memo } from "react";

import {
  SectionHeading,
  type SectionHeadingProps,
} from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

export const WIZARD_STEP_CONTENT_TOKENS = {
  container: DETAIL_PANEL_TOKENS.contentWidth,
} as const;

interface WizardStepContentProps {
  title: string;
  description?: string;
  icon?: SectionHeadingProps["icon"];
  children?: React.ReactNode;
  className?: string;
}

const WizardStepContent: React.FC<WizardStepContentProps> = memo(
  ({ title, description, icon: Icon, children, className = "" }) => {
    return (
      <SectionHeading
        appearance="intro"
        headingLevel={1}
        title={title}
        description={description}
        icon={Icon}
        className={`${WIZARD_STEP_CONTENT_TOKENS.container} ${className}`.trim()}
      >
        {children}
      </SectionHeading>
    );
  }
);

WizardStepContent.displayName = "WizardStepContent";

export default WizardStepContent;
