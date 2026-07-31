import { useSetAtom } from "jotai";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import AppLogo from "@src/components/AppLogo";
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

import { STEP_CONFIGS } from "./config";
import {
  canCompleteSetupStep,
  canNavigateToSetupStep,
  getVisibleSetupStepIds,
} from "./flow";
import "./index.scss";
import { SetupOperationError } from "./steps";
import { useSetupWalkthroughController } from "./useSetupWalkthroughController";

const WALKTHROUGH_STYLES = `
  body.walkthrough-mode .tab-bar { display: none !important; }
  body.walkthrough-mode [data-toolbar-section] { display: none !important; }
`;

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
    <div className="flex h-full w-full flex-col">
      <div className="walkthrough-brand">
        <AppLogo className="walkthrough-brand-mark" size={32} alt="" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight text-text-1">
              ORGII
            </span>
            <span className="walkthrough-brand-tag">
              {t("readiness.sidebar.brandTag")}
            </span>
          </div>
          <div className="mt-1 max-w-52 text-xs leading-5 text-text-3">
            {t("readiness.sidebar.subtitle")}
          </div>
        </div>
      </div>

      <div className="walkthrough-progress mt-6">
        <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
          <span className="font-medium text-text-2">
            {t("readiness.sidebar.stepProgress", {
              current: stepNumber,
              total: visibleSteps.length,
            })}
          </span>
        </div>
        <div
          className="h-px overflow-hidden bg-border-2"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={visibleSteps.length}
          aria-valuenow={stepNumber}
        >
          <div
            className="h-full bg-text-1 transition-[width] duration-300 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <div
        className="walkthrough-step-list mt-5 flex flex-1 flex-col overflow-y-auto"
        aria-label={t("readiness.sidebar.ariaLabel")}
      >
        {visibleSteps.map((step, index) => {
          const StepIcon = step.icon;
          const isActive = step.id === controller.currentStepId;
          const isCompleted = controller.progress.completedStepIds.includes(
            step.id
          );
          const canNavigate = canNavigateToSetupStep(
            controller.progress,
            step.id
          );
          return (
            <div key={step.id} className="relative pb-1">
              {index < visibleSteps.length - 1 && (
                <span
                  className="walkthrough-step-connector pointer-events-none absolute bottom-0 top-9 flex justify-center"
                  aria-hidden
                >
                  <span
                    className={`h-full w-px ${
                      isCompleted ? "bg-success-6/45" : "bg-border-2"
                    }`}
                  />
                </span>
              )}
              <button
                className={`walkthrough-step-button group flex w-full items-center gap-3 rounded-lg border py-2 text-left transition-colors duration-150 ${
                  isActive
                    ? "border-border-1 bg-fill-2"
                    : canNavigate
                      ? "cursor-pointer border-transparent bg-transparent hover:bg-fill-2"
                      : "cursor-not-allowed border-transparent bg-transparent opacity-45"
                }`}
                onClick={() => void controller.goToStep(step.id)}
                disabled={!canNavigate || isClosing}
                aria-current={isActive ? "step" : undefined}
                type="button"
                data-testid={`setup-step-${step.id}`}
              >
                <div
                  className={`walkthrough-step-node relative z-10 flex flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                    isActive
                      ? "border-text-1 bg-text-1 text-bg-1"
                      : isCompleted
                        ? "border-border-2 bg-bg-2 text-text-1"
                        : "border-border-2 bg-bg-2 text-text-3"
                  }`}
                >
                  {isCompleted ? <Check size={13} /> : <StepIcon size={13} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`truncate text-sm font-medium ${
                      isActive ? "text-text-1" : "text-text-2"
                    }`}
                  >
                    {t(`steps.${step.i18nKey}.title`)}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-text-3">
                    {t(`steps.${step.i18nKey}.description`)}
                  </div>
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const rightContent = (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="walkthrough-mobile-progress">
        <span>
          {t("readiness.sidebar.stepProgress", {
            current: stepNumber,
            total: visibleSteps.length,
          })}
        </span>
        <span className="font-medium text-primary-6">
          {t(`steps.${currentStep.i18nKey}.title`)}
        </span>
      </div>
      <div className="walkthrough-content-scroll relative flex min-h-0 flex-1 flex-col overflow-y-auto px-10 py-9">
        <div
          key={currentStep.id}
          className="walkthrough-step-enter flex min-h-full w-full flex-col"
        >
          <CurrentStepComponent controller={controller} />
          <SetupOperationError controller={controller} />
        </div>
      </div>
      <PanelFooter
        className="walkthrough-footer h-16 px-8"
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
        className="walkthrough-shell"
        cardClassName="walkthrough-card"
        leftPanelClassName="walkthrough-sidebar"
        rightPanelClassName="walkthrough-main"
        leftContent={leftContent}
        rightContent={rightContent}
      />
    </>
  );
};

export default SetupWalkthrough;
