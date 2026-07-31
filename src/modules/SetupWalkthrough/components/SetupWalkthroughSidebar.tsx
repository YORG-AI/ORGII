import React, { memo } from "react";

import AppLogo from "@src/components/AppLogo";
import ProgressBar from "@src/components/ProgressBar";
import { SectionDescription } from "@src/modules/shared/layouts/SectionLayout";
import {
  WizardStepNavigation,
  type WizardStepNavigationItem,
} from "@src/scaffold/WizardSystem";

import type { SetupStepId } from "../flow";
import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";

export interface SetupWalkthroughSidebarProps {
  brandTag: string;
  description: string;
  progressLabel: string;
  progressPercent: number;
  navigationLabel: string;
  navigationItems: WizardStepNavigationItem<SetupStepId>[];
  activeStepId: SetupStepId;
  onSelectStep: (stepId: SetupStepId) => void | Promise<void>;
  disabled?: boolean;
  style?: React.CSSProperties;
}

/**
 * Atomic setup-sidebar composition. Product flow and persistence stay with the
 * parent; this component composes the canonical logo, progress, and wizard
 * navigation primitives into the setup shell.
 */
const SetupWalkthroughSidebar: React.FC<SetupWalkthroughSidebarProps> = memo(
  ({
    brandTag,
    description,
    progressLabel,
    progressPercent,
    navigationLabel,
    navigationItems,
    activeStepId,
    onSelectStep,
    disabled = false,
    style,
  }) => (
    <aside
      className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebarContent}
      style={style}
    >
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandRow}>
        <div
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandLogoFrame}
          aria-hidden
        >
          <AppLogo
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandLogo}
            size={28}
            alt=""
          />
        </div>
        <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandCopy}>
          <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandTitleRow}>
            <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandTitle}>
              ORGII
            </span>
            <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandTag}>
              {brandTag}
            </span>
          </div>
          <SectionDescription
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandDescription}
          >
            {description}
          </SectionDescription>
        </div>
      </div>

      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.progress}>
        <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.progressLabel}>
          <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.progressLabelText}>
            {progressLabel}
          </span>
        </div>
        <ProgressBar
          percent={progressPercent}
          color="bg-text-1"
          trackColor="bg-border-2"
          height="h-px"
          ariaLabel={progressLabel}
        />
      </div>

      <WizardStepNavigation
        items={navigationItems}
        activeId={activeStepId}
        onSelect={onSelectStep}
        ariaLabel={navigationLabel}
        disabled={disabled}
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.navigation}
        testIdPrefix="setup-step"
      />
    </aside>
  )
);

SetupWalkthroughSidebar.displayName = "SetupWalkthroughSidebar";

export default SetupWalkthroughSidebar;
