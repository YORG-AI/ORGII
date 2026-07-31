import { useSetAtom } from "jotai";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { ROUTES } from "@src/config/routes";
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { signalGitHubStarValueMoment } from "@src/features/GitHubStar";
import { OnboardingLayout } from "@src/modules/shared/layouts";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import { TUTORIALS } from "@src/scaffold/Tutorials/tutorialRegistry";
import {
  openCreateTargetInChatPanelStartPageAtom,
  openTeamInboxInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabOpenAtoms";
import { saveSettingsBatchAtom } from "@src/store/settings/settingsAtom";
import {
  type SetupWalkthroughOutcome,
  shouldSignalGitHubStarAfterSetup,
} from "@src/store/settings/setupWalkthrough";
import { CHAT_PANEL_CREATE_TARGET } from "@src/store/ui/chatPanelAtom";

import SetupWalkthroughSidebar from "./components/SetupWalkthroughSidebar";
import { STEP_CONFIGS } from "./config";
import {
  canCompleteSetupStep,
  canNavigateToSetupStep,
  getVisibleSetupStepIds,
} from "./flow";
import {
  SETUP_WALKTHROUGH_LAYOUT_TOKENS,
  resolveSetupSidebarLayout,
} from "./layoutTokens";
import { SetupOperationError } from "./steps/ReadinessSteps";
import { useSetupWalkthroughController } from "./useSetupWalkthroughController";

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
  const controller = useSetupWalkthroughController();
  const saveSettings = useSetAtom(saveSettingsBatchAtom);
  const openCreateTarget = useSetAtom(openCreateTargetInChatPanelStartPageAtom);
  const openTeamInbox = useSetAtom(openTeamInboxInChatPanelTabAtom);
  const [isClosing, setIsClosing] = useState(false);
  const closingRef = useRef(false);

  React.useLayoutEffect(() => {
    document.body.classList.add("walkthrough-mode");
    return () => document.body.classList.remove("walkthrough-mode");
  }, []);

  const visibleStepIds = getVisibleSetupStepIds(controller.progress);
  const visibleSteps = useMemo(
    () => STEP_CONFIGS.filter((step) => visibleStepIds.includes(step.id)),
    [visibleStepIds]
  );
  const currentIndex = visibleSteps.findIndex(
    (step) => step.id === controller.currentStepId
  );
  const currentStep = visibleSteps[Math.max(0, currentIndex)];
  const CurrentStepComponent = currentStep.component;
  const isFirstStep = currentIndex <= 0;
  const isLastStep = currentIndex === visibleSteps.length - 1;
  const canContinue = canCompleteSetupStep(
    controller.progress,
    controller.currentStepId
  );
  const stepNumber = Math.max(1, currentIndex + 1);
  const progressPercent = Math.round(
    (stepNumber / Math.max(1, visibleSteps.length)) * 100
  );
  const progressLabel = t("readiness.sidebar.stepProgress", {
    current: stepNumber,
    total: visibleSteps.length,
  });
  const navigationItems = visibleSteps.map((step) => ({
    id: step.id,
    title: t(`steps.${step.i18nKey}.title`),
    description: t(`steps.${step.i18nKey}.description`),
    icon: step.icon,
    completed: controller.progress.completedStepIds.includes(step.id),
    disabled: !canNavigateToSetupStep(controller.progress, step.id),
  }));

  const landInSelectedOutcome = useCallback(() => {
    if (controller.progress.goal === "team_activity") {
      openTeamInbox(t("readiness.destinations.teamInbox"));
    } else {
      openCreateTarget({
        target:
          controller.progress.goal === "work_management"
            ? CHAT_PANEL_CREATE_TARGET.WORK_ITEM
            : CHAT_PANEL_CREATE_TARGET.AGENT_SESSION,
        title: t("readiness.destinations.launchpad"),
      });
    }
  }, [controller.progress.goal, openCreateTarget, openTeamInbox, t]);

  const closeWalkthrough = useCallback(
    async (outcome: Exclude<SetupWalkthroughOutcome, "open">) => {
      if (closingRef.current) return;
      closingRef.current = true;
      setIsClosing(true);
      try {
        const finalProgress =
          outcome === "completed"
            ? {
                ...controller.progress,
                completedStepIds: Array.from(
                  new Set([...controller.progress.completedStepIds, "ready"])
                ),
              }
            : controller.progress;
        await saveSettings({
          "general.setupWalkthroughOutcome": outcome,
          "general.setupWalkthroughProgress": finalProgress,
        });
        if (shouldSignalGitHubStarAfterSetup(outcome)) {
          signalGitHubStarValueMoment();
        }
        if (outcome === "completed") landInSelectedOutcome();
        navigate(ROUTES.workStation.base.path, { replace: true });
        if (outcome === "completed" && finalProgress.tutorialId) {
          const tutorial = TUTORIALS.find(
            (item) => item.id === finalProgress.tutorialId
          );
          if (tutorial) {
            window.setTimeout(
              () => window.dispatchEvent(new CustomEvent(tutorial.eventName)),
              250
            );
          }
        }
      } catch {
        Message.error(t("common:status.saveFailed"));
      } finally {
        closingRef.current = false;
        setIsClosing(false);
      }
    },
    [controller.progress, landInSelectedOutcome, navigate, saveSettings, t]
  );

  const handleNext = useCallback(async () => {
    if (isLastStep) {
      await closeWalkthrough("completed");
      return;
    }
    try {
      await controller.goNext();
    } catch {
      Message.error(t("common:status.saveFailed"));
    }
  }, [closeWalkthrough, controller, isLastStep, t]);

  const handleBack = useCallback(async () => {
    try {
      await controller.goBack();
    } catch {
      Message.error(t("common:status.saveFailed"));
    }
  }, [controller, t]);

  const leftContent = (
    <SetupWalkthroughSidebar
      brandTag={t("readiness.sidebar.brandTag")}
      description={t("readiness.sidebar.subtitle")}
      progressLabel={progressLabel}
      progressPercent={progressPercent}
      navigationLabel={t("readiness.sidebar.ariaLabel")}
      navigationItems={navigationItems}
      activeStepId={controller.currentStepId}
      onSelectStep={controller.goToStep}
      disabled={isClosing}
      style={SETUP_SIDEBAR_CONTENT_STYLE}
    />
  );

  const rightContent = (
    <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mainContent}>
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mobileProgress}>
        <span>
          {t("readiness.sidebar.stepProgress", {
            current: stepNumber,
            total: visibleSteps.length,
          })}
        </span>
        <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.mobileProgressTitle}>
          {t(`steps.${currentStep.i18nKey}.title`)}
        </span>
      </div>
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.contentScroll}>
        <div
          key={currentStep.id}
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.stepFrame}
        >
          <CurrentStepComponent controller={controller} />
          <SetupOperationError controller={controller} />
        </div>
      </div>
      <PanelFooter
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.footer}
        primaryButtonSize="default"
        secondaryButtonSize="default"
        left={
          !isFirstStep ? (
            <Button
              icon={<ArrowLeft size={16} />}
              onClick={() => void handleBack()}
              disabled={isClosing || controller.activeOperation !== null}
              data-testid="setup-back"
            >
              {t("common:actions.back")}
            </Button>
          ) : undefined
        }
        secondaryActions={
          !isLastStep
            ? [
                {
                  label: t("navigation.skipSetup"),
                  onClick: () => void closeWalkthrough("dismissed"),
                  disabled: isClosing || controller.activeOperation !== null,
                  dataTestId: "setup-skip",
                },
              ]
            : undefined
        }
        primaryAction={{
          label: isLastStep
            ? t("readiness.ready.openDestination")
            : t("common:actions.continue"),
          onClick: () => void handleNext(),
          loading: isClosing,
          disabled:
            isClosing || controller.activeOperation !== null || !canContinue,
          icon: isLastStep ? <Check size={16} /> : <ArrowRight size={16} />,
          dataTestId: isLastStep ? "setup-finish" : "setup-continue",
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
