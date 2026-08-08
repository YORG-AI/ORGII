import React, { memo } from "react";

import setupMascot from "@src/assets/onboarding/org2-pearl-relay-mascot.png";
import AppLogo from "@src/components/AppLogo";

import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";
import {
  SETUP_WALKTHROUGH_PRESENTATION,
  type SetupWalkthroughPresentation,
} from "../presentation";
import SetupApplicationPreview from "./SetupApplicationPreview";

export interface SetupWalkthroughSidebarProps {
  title: React.ReactNode;
  description: string;
  presentation: SetupWalkthroughPresentation;
}

/** Preview host; presentation changes never replace the settings column. */
const SetupWalkthroughSidebar: React.FC<SetupWalkthroughSidebarProps> = memo(
  ({ title, description, presentation }) => {
    const showMascot = presentation === SETUP_WALKTHROUGH_PRESENTATION.MASCOT;

    return (
      <section
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebarContent}
        aria-labelledby="setup-hero-title"
      >
        <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.hero}>
          <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroBrandRow}>
            <AppLogo
              className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandLogo}
              size={36}
              alt=""
            />
            <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandTitle}>
              ORGII
            </span>
          </div>

          <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroCopy}>
            <h1
              id="setup-hero-title"
              className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroTitle}
            >
              {title}
            </h1>
            <p className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroDescription}>
              {description}
            </p>
          </div>

          <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroVisual}>
            {showMascot ? (
              <div data-testid="setup-mascot-preview" aria-hidden>
                <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroPlanet} />
                <img
                  src={setupMascot}
                  alt=""
                  className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroMascot}
                />
              </div>
            ) : (
              <div
                className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.appPreviewWrap}
                data-testid="setup-compact-preview"
              >
                <SetupApplicationPreview />
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }
);

SetupWalkthroughSidebar.displayName = "SetupWalkthroughSidebar";

export default SetupWalkthroughSidebar;
