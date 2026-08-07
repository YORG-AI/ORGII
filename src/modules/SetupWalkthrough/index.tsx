/**
 * Setup Walkthrough Page
 *
 * A wizard-style onboarding flow for first-time users.
 * Also re-enterable from Settings > General.
 *
 * Renders outside AppShell (no sidebar) for a focused experience.
 */
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import "@src/components/DevPassport/devpassport.css";
import { ROUTES } from "@src/config/routes";
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { OnboardingLayout } from "@src/modules/shared/layouts";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";

import { STEP_CONFIGS } from "./config";
import "./index.scss";

// ============================================
// Global Styles (injected)
// ============================================

const WALKTHROUGH_STYLES = `
  body.walkthrough-mode .tab-bar {
    display: none !important;
  }
  body.walkthrough-mode [data-toolbar-section] {
    display: none !important;
  }
  @keyframes fadeInUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

// ============================================
// Main Component
// ============================================

const SetupWalkthrough: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation("onboarding");
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  // Add/remove body class for hiding tabbar
  React.useLayoutEffect(() => {
    document.body.classList.add("walkthrough-mode");
    return () => {
      document.body.classList.remove("walkthrough-mode");
    };
  }, []);

  const currentStep = STEP_CONFIGS[currentStepIndex];
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === STEP_CONFIGS.length - 1;

  const handleNext = useCallback(() => {
    if (isLastStep) {
      // Mark setup as complete and navigate to WorkStation
      localStorage.setItem("setup_walkthrough_completed", "true");
      navigate(ROUTES.workStation.base.path, { replace: true });
    } else {
      setCurrentStepIndex((prev) => prev + 1);
    }
  }, [isLastStep, navigate]);

  const handleBack = useCallback(() => {
    if (!isFirstStep) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  }, [isFirstStep]);

  const handleSkip = useCallback(() => {
    // Mark setup as complete and navigate to WorkStation
    localStorage.setItem("setup_walkthrough_completed", "true");
    navigate(ROUTES.workStation.base.path, { replace: true });
  }, [navigate]);

  // Left content: Step navigation
  const leftContent = (
    <div className="flex h-full w-full flex-col gap-4">
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {STEP_CONFIGS.map((step, index) => {
          const StepIcon = step.icon;
          const isActive = index === currentStepIndex;
          const isCompleted = index < currentStepIndex;

          return (
            <button
              key={step.id}
              className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border-none px-3 py-2.5 text-left transition-all ${
                isActive
                  ? "bg-fill-2"
                  : isCompleted
                    ? "bg-transparent opacity-70"
                    : "bg-transparent hover:bg-fill-3"
              }`}
              onClick={() => setCurrentStepIndex(index)}
              type="button"
            >
              <div
                className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${
                  isActive
                    ? "bg-primary-6 text-white"
                    : isCompleted
                      ? "bg-success-6 text-white"
                      : "bg-fill-3 text-text-2"
                }`}
              >
                {isCompleted ? <Check size={16} /> : <StepIcon size={16} />}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-text-1">
                  {t(`steps.${step.i18nKey}.title`)}
                </span>
                <span className="text-xs leading-snug text-text-3">
                  {t(`steps.${step.i18nKey}.description`)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  // Right content: Step content + footer
  const rightContent = (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="relative flex flex-1 items-center justify-center overflow-y-auto p-6">
        {currentStep.content}
      </div>

      <PanelFooter
        left={
          !isFirstStep ? (
            <Button
              size="default"
              icon={<ArrowLeft size={16} />}
              onClick={handleBack}
            >
              {t("common:actions.back")}
            </Button>
          ) : undefined
        }
        secondaryActions={
          !isLastStep
            ? [{ label: t("navigation.skipSetup"), onClick: handleSkip }]
            : undefined
        }
        primaryAction={{
          label: isLastStep
            ? t("navigation.getStarted")
            : t("common:actions.continue"),
          onClick: handleNext,
          icon: isLastStep ? <Check size={16} /> : <ArrowRight size={16} />,
        }}
      />
    </div>
  );

  return (
    <>
      {/* Global styles for walkthrough mode */}
      <style nonce={CODEMIRROR_STYLE_NONCE}>{WALKTHROUGH_STYLES}</style>

      <OnboardingLayout
        variant="contained"
        size="large"
        bodyClass="walkthrough-mode"
        leftContent={leftContent}
        rightContent={rightContent}
      />
    </>
  );
};

export default SetupWalkthrough;
