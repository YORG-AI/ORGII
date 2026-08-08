import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import AppLogo from "@src/components/AppLogo";
import Message from "@src/components/Message";
import { ROUTES } from "@src/config/routes";
import { normalizeSetupWalkthroughProgress } from "@src/config/settingsSchema/setupWalkthroughProgress";
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { OnboardingLayout } from "@src/modules/shared/layouts";
import {
  saveSettingsBatchAtom,
  settingsAtom,
} from "@src/store/settings/settingsAtom";
import { applicationPreviewStyleAtom } from "@src/store/ui/globalPreferencesPanelAtom";

import SetupPreferencesPanel from "./components/SetupPreferencesPanel";
import SetupWalkthroughSidebar from "./components/SetupWalkthroughSidebar";
import {
  SETUP_WALKTHROUGH_HERO_PANEL_STYLE,
  SETUP_WALKTHROUGH_LAYOUT_TOKENS,
} from "./layoutTokens";
import { completePreferenceSetup } from "./preferenceSetup";
import "./setupWalkthrough.scss";

type SetupWalkthroughOutcome = "open" | "completed" | "dismissed";

const WALKTHROUGH_STYLES = `
  body.walkthrough-mode .tab-bar { display: none !important; }
  body.walkthrough-mode [data-toolbar-section] { display: none !important; }
`;

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
  const presentation = useAtomValue(applicationPreviewStyleAtom);
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

  const preferences = (
    <SetupPreferencesPanel
      isClosing={isClosing}
      onComplete={() => void closeWalkthrough("completed")}
      onSkip={() => void closeWalkthrough("dismissed")}
    />
  );

  const previewContent = (
    <SetupWalkthroughSidebar
      presentation={presentation}
      title={
        <Trans
          ns="onboarding"
          i18nKey="readiness.hero.title"
          components={{
            brand: (
              <span
                className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.heroBrandAccent}
              />
            ),
          }}
        />
      }
      description={t("readiness.hero.description")}
    />
  );

  const preferenceContent = (
    <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mainContent}>
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mobileBrand}>
        <AppLogo size={28} className="rounded-lg" alt="" />
        <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mobileBrandTitle}>
          ORGII
        </span>
      </div>
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.stepFrame}>
        {preferences}
      </div>
    </div>
  );

  return (
    <>
      <style nonce={CODEMIRROR_STYLE_NONCE}>{WALKTHROUGH_STYLES}</style>
      <OnboardingLayout
        variant="fullscreen"
        size="large"
        bodyClass="walkthrough-mode"
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.shell}
        cardClassName={SETUP_WALKTHROUGH_LAYOUT_TOKENS.card}
        leftPanelClassName={SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebar}
        leftPanelStyle={SETUP_WALKTHROUGH_HERO_PANEL_STYLE}
        rightPanelClassName={SETUP_WALKTHROUGH_LAYOUT_TOKENS.main}
        leftContent={previewContent}
        rightContent={preferenceContent}
      />
    </>
  );
};

export default SetupWalkthrough;
