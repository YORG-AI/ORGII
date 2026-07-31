import { useAtomValue, useSetAtom } from "jotai";
import { Check } from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Message from "@src/components/Message";
import { ROUTES } from "@src/config/routes";
import { normalizeSetupWalkthroughProgress } from "@src/config/settingsSchema/setupWalkthroughProgress";
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { signalGitHubStarValueMoment } from "@src/features/GitHubStar";
import { OnboardingLayout } from "@src/modules/shared/layouts";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import {
  saveSettingsBatchAtom,
  settingsAtom,
} from "@src/store/settings/settingsAtom";
import {
  type SetupWalkthroughOutcome,
  shouldSignalGitHubStarAfterSetup,
} from "@src/store/settings/setupWalkthrough";

import SetupPreferencesPanel from "./components/SetupPreferencesPanel";
import SetupWalkthroughSidebar from "./components/SetupWalkthroughSidebar";
import {
  SETUP_WALKTHROUGH_LAYOUT_TOKENS,
  resolveSetupSidebarLayout,
} from "./layoutTokens";
import { completePreferenceSetup } from "./preferenceSetup";

const WALKTHROUGH_STYLES = `
  body.walkthrough-mode .tab-bar { display: none !important; }
  body.walkthrough-mode [data-toolbar-section] { display: none !important; }
`;

const SETUP_SIDEBAR_LAYOUT = resolveSetupSidebarLayout();
const SETUP_SIDEBAR_STYLE: React.CSSProperties = {
  width: SETUP_SIDEBAR_LAYOUT.panelWidth,
};
const SETUP_SIDEBAR_CONTENT_STYLE: React.CSSProperties = {
  paddingTop: SETUP_SIDEBAR_LAYOUT.contentTopInset,
};

const SetupWalkthrough: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation("onboarding");
  const saveSettings = useSetAtom(saveSettingsBatchAtom);
  const storedProgress =
    useAtomValue(settingsAtom)["general.setupWalkthroughProgress"];
  const progress = useMemo(
    () => normalizeSetupWalkthroughProgress(storedProgress),
    [storedProgress]
  );
  const [isClosing, setIsClosing] = useState(false);
  const closingRef = useRef(false);

  const closeWalkthrough = useCallback(
    async (outcome: Exclude<SetupWalkthroughOutcome, "open">) => {
      if (closingRef.current) return;
      closingRef.current = true;
      setIsClosing(true);
      try {
        const finalProgress =
          outcome === "completed"
            ? completePreferenceSetup(progress)
            : progress;
        await saveSettings({
          "general.setupWalkthroughOutcome": outcome,
          "general.setupWalkthroughProgress": finalProgress,
        });
        if (shouldSignalGitHubStarAfterSetup(outcome)) {
          signalGitHubStarValueMoment();
        }
        navigate(ROUTES.workStation.base.path, { replace: true });
      } catch {
        Message.error(t("common:status.saveFailed"));
      } finally {
        closingRef.current = false;
        setIsClosing(false);
      }
    },
    [navigate, progress, saveSettings, t]
  );

  const leftContent = (
    <SetupWalkthroughSidebar
      brandTag={t("readiness.sidebar.brandTag")}
      description={t("readiness.sidebar.subtitle")}
      disabled={isClosing}
      style={SETUP_SIDEBAR_CONTENT_STYLE}
    />
  );

  const rightContent = (
    <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mainContent}>
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mobileProgress}>
        <span>ORGII</span>
        <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mobileProgressTitle}>
          {t("readiness.sidebar.brandTag")}
        </span>
      </div>
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.contentScroll}>
        <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.stepFrame}>
          <SetupPreferencesPanel />
        </div>
      </div>
      <PanelFooter
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.footer}
        primaryButtonSize="default"
        secondaryButtonSize="default"
        secondaryActions={[
          {
            label: t("navigation.skipSetup"),
            onClick: () => void closeWalkthrough("dismissed"),
            disabled: isClosing,
            dataTestId: "setup-skip",
          },
        ]}
        primaryAction={{
          label: t("navigation.getStarted"),
          onClick: () => void closeWalkthrough("completed"),
          loading: isClosing,
          disabled: isClosing,
          icon: <Check size={16} />,
          dataTestId: "setup-finish",
        }}
      />
    </div>
  );

  return (
    <>
      <style nonce={CODEMIRROR_STYLE_NONCE}>{WALKTHROUGH_STYLES}</style>
      <OnboardingLayout
        variant="contained"
        size="large"
        bodyClass="walkthrough-mode"
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.shell}
        cardClassName={SETUP_WALKTHROUGH_LAYOUT_TOKENS.card}
        leftPanelClassName={SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebar}
        leftPanelStyle={SETUP_SIDEBAR_STYLE}
        rightPanelClassName={SETUP_WALKTHROUGH_LAYOUT_TOKENS.main}
        leftContent={leftContent}
        rightContent={rightContent}
      />
    </>
  );
};

export default SetupWalkthrough;
