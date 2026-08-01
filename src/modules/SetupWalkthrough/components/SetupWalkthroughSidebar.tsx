import React, { memo } from "react";

import setupMascot from "@src/assets/onboarding/org2-pearl-relay-mascot.png";
import AppLogo from "@src/components/AppLogo";

import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";

export interface SetupWalkthroughSidebarProps {
  title: React.ReactNode;
  description: string;
}

/**
 * Cinematic first-run hero. It owns presentation only; preference values,
 * completion, and navigation remain with the setup controller surface.
 */
const SetupWalkthroughSidebar: React.FC<SetupWalkthroughSidebarProps> = memo(
  ({ title, description }) => (
    <section
      className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebarContent}
      aria-labelledby="setup-hero-title"
    >
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.hero}>
        <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.brandRow}>
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

        <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroVisual} aria-hidden>
          <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroPlanet} />
          <img
            src={setupMascot}
            alt=""
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroMascot}
          />
        </div>
      </div>
    </section>
  )
);

SetupWalkthroughSidebar.displayName = "SetupWalkthroughSidebar";

export default SetupWalkthroughSidebar;
