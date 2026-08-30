import { AnimatePresence, motion } from "framer-motion";
import { useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { getMaterialConfig } from "@src/components/Glass/config";
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  Cancel01Icon,
  HugeiconsIcon,
  Tick01Icon,
} from "@src/icons";
import type { SourceControlFilterMode } from "@src/modules/WorkStation/shared/SidebarModules/SourceControl/SourceControlFilterHeader";
import {
  POPUP_ANIMATION,
  POPUP_SHADOW,
} from "@src/scaffold/shared/popupTokens";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { sourceControlFilterModeAtom } from "@src/store/workstation/codeEditor/sourceControlFilterModeAtom";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { createAnimationFrameScheduler } from "./animationFrameScheduler";
import { CODE_EDITOR_TOUR_TARGETS } from "./codeEditorTourConfig";

type CodeEditorTourTarget =
  (typeof CODE_EDITOR_TOUR_TARGETS)[keyof typeof CODE_EDITOR_TOUR_TARGETS];

interface TourStep {
  id: string;
  target: CodeEditorTourTarget;
  fallbackTarget?: CodeEditorTourTarget;
  openSourceControl?: boolean;
  openDashboard?: boolean;
  sourceControlFilterMode?: SourceControlFilterMode;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CodeEditorTourProps {
  open: boolean;
  onClose: () => void;
}

const TOUR_STEPS: TourStep[] = [
  {
    id: "tabs",
    target: CODE_EDITOR_TOUR_TARGETS.tabBar,
  },
  {
    id: "repo-selector",
    target: CODE_EDITOR_TOUR_TARGETS.repoSelector,
  },
  {
    id: "branch-selector",
    target: CODE_EDITOR_TOUR_TARGETS.branchSelector,
    fallbackTarget: CODE_EDITOR_TOUR_TARGETS.repoSelector,
  },
  {
    id: "editor-surface",
    target: CODE_EDITOR_TOUR_TARGETS.editorSurface,
  },
  {
    id: "create-tabs",
    target: CODE_EDITOR_TOUR_TARGETS.plusMenu,
  },
  {
    id: "source-control",
    target: CODE_EDITOR_TOUR_TARGETS.sourceControl,
    openSourceControl: true,
    sourceControlFilterMode: "uncommitted",
  },
  {
    id: "git-history",
    target: CODE_EDITOR_TOUR_TARGETS.gitHistory,
    fallbackTarget: CODE_EDITOR_TOUR_TARGETS.sourceControl,
    openSourceControl: true,
    sourceControlFilterMode: "history",
  },
  {
    id: "dashboard",
    target: CODE_EDITOR_TOUR_TARGETS.dashboard,
    openDashboard: true,
  },
];

const POPOVER_WIDTH = 320;
const VIEWPORT_PADDING = 16;
const TARGET_PADDING = 8;
const POPOVER_ESTIMATED_HEIGHT = 206;

function getTargetRect(target: CodeEditorTourTarget): TargetRect | null {
  const elements = document.querySelectorAll<HTMLElement>(
    `[data-tour-target="${target}"]`
  );

  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildHighlightStyle(rect: TargetRect): React.CSSProperties {
  return {
    top: rect.top - TARGET_PADDING,
    left: rect.left - TARGET_PADDING,
    width: rect.width + TARGET_PADDING * 2,
    height: rect.height + TARGET_PADDING * 2,
  };
}

function buildOverlaySegments(rect: TargetRect): React.CSSProperties[] {
  const highlight = {
    top: rect.top - TARGET_PADDING,
    left: rect.left - TARGET_PADDING,
    width: rect.width + TARGET_PADDING * 2,
    height: rect.height + TARGET_PADDING * 2,
  };
  const { width: viewportWidth, height: viewportHeight } = getViewportSize();
  const top = clamp(highlight.top, 0, viewportHeight);
  const left = clamp(highlight.left, 0, viewportWidth);
  const right = clamp(highlight.left + highlight.width, 0, viewportWidth);
  const bottom = clamp(highlight.top + highlight.height, 0, viewportHeight);

  return [
    { top: 0, left: 0, width: viewportWidth, height: top },
    {
      top: bottom,
      left: 0,
      width: viewportWidth,
      height: viewportHeight - bottom,
    },
    { top, left: 0, width: left, height: bottom - top },
    { top, left: right, width: viewportWidth - right, height: bottom - top },
  ];
}

function buildPopoverStyle(rect: TargetRect): React.CSSProperties {
  const { width: vw, height: vh } = getViewportSize();
  const hasRoomBelow = vh - (rect.top + rect.height) > POPOVER_ESTIMATED_HEIGHT;
  const hasRoomRight = vw - (rect.left + rect.width) > POPOVER_WIDTH + 36;
  const hasRoomLeft = rect.left > POPOVER_WIDTH + 36;

  if (hasRoomRight) {
    return {
      top: clamp(
        rect.top + rect.height / 2 - POPOVER_ESTIMATED_HEIGHT / 2,
        VIEWPORT_PADDING,
        vh - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_PADDING
      ),
      left: rect.left + rect.width + TARGET_PADDING + 12,
      width: POPOVER_WIDTH,
    };
  }

  if (hasRoomLeft) {
    return {
      top: clamp(
        rect.top + rect.height / 2 - POPOVER_ESTIMATED_HEIGHT / 2,
        VIEWPORT_PADDING,
        vh - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_PADDING
      ),
      left: rect.left - POPOVER_WIDTH - TARGET_PADDING - 12,
      width: POPOVER_WIDTH,
    };
  }

  const top = hasRoomBelow
    ? rect.top + rect.height + TARGET_PADDING + 10
    : rect.top - POPOVER_ESTIMATED_HEIGHT - TARGET_PADDING - 10;

  return {
    top: clamp(
      top,
      VIEWPORT_PADDING,
      vh - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_PADDING
    ),
    left: clamp(
      rect.left + rect.width / 2 - POPOVER_WIDTH / 2,
      VIEWPORT_PADDING,
      vw - POPOVER_WIDTH - VIEWPORT_PADDING
    ),
    width: POPOVER_WIDTH,
  };
}

const CodeEditorTour: React.FC<CodeEditorTourProps> = ({ open, onClose }) => {
  const { t } = useTranslation("onboarding");
  const { isDark } = useCurrentTheme();
  const setStationMode = useSetAtom(stationModeAtom);
  const setSourceControlFilterMode = useSetAtom(sourceControlFilterModeAtom);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);

  const currentStep = TOUR_STEPS[stepIndex];
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === TOUR_STEPS.length - 1;

  useEffect(() => {
    if (!open) return;
    setStationMode("my-station");
    if (currentStep.sourceControlFilterMode) {
      setSourceControlFilterMode(currentStep.sourceControlFilterMode);
    }
    if (currentStep.openSourceControl) {
      void WorkStationViewService.openSourceControlTab();
    }
    if (currentStep.openDashboard) {
      void WorkStationViewService.openFileFolderTab();
    }
  }, [
    currentStep.openDashboard,
    currentStep.openSourceControl,
    currentStep.sourceControlFilterMode,
    open,
    setSourceControlFilterMode,
    setStationMode,
  ]);

  const updateTargetRect = useCallback(() => {
    if (!open) return;
    const rect =
      getTargetRect(currentStep.target) ??
      (currentStep.fallbackTarget
        ? getTargetRect(currentStep.fallbackTarget)
        : null);
    setTargetRect(rect);
  }, [currentStep.fallbackTarget, currentStep.target, open]);

  useEffect(() => {
    if (!open) return;

    const scheduler = createAnimationFrameScheduler(updateTargetRect, {
      requestFrame: window.requestAnimationFrame.bind(window),
      cancelFrame: window.cancelAnimationFrame.bind(window),
    });
    const retryId = window.setTimeout(scheduler.schedule, 220);
    const lateRetryId = window.setTimeout(scheduler.schedule, 520);
    scheduler.schedule();
    window.addEventListener("resize", scheduler.schedule);
    window.addEventListener("scroll", scheduler.schedule, true);

    return () => {
      scheduler.cancel();
      window.clearTimeout(retryId);
      window.clearTimeout(lateRetryId);
      window.removeEventListener("resize", scheduler.schedule);
      window.removeEventListener("scroll", scheduler.schedule, true);
    };
  }, [open, updateTargetRect]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "ArrowRight" || event.key === ">") {
        event.preventDefault();
        setStepIndex((value) => Math.min(value + 1, TOUR_STEPS.length - 1));
      }
      if (event.key === "ArrowLeft" || event.key === "<") {
        event.preventDefault();
        setStepIndex((value) => Math.max(value - 1, 0));
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, open]);

  const containerMaterial = useMemo(
    () => getMaterialConfig(isDark, "thick"),
    [isDark]
  );

  const popoverGlassStyle = useMemo<React.CSSProperties>(() => {
    const borderColor = isDark
      ? "rgba(255, 255, 255, 0.10)"
      : "rgba(255, 255, 255, 0.24)";
    return {
      backdropFilter: `blur(${containerMaterial.blur}px)`,
      WebkitBackdropFilter: `blur(${containerMaterial.blur}px)`,
      background: containerMaterial.background,
      border: `1px solid ${borderColor}`,
      boxShadow: POPUP_SHADOW,
    };
  }, [containerMaterial, isDark]);

  const goPrevious = useCallback(() => {
    setStepIndex((value) => Math.max(value - 1, 0));
  }, []);

  const goNext = useCallback(() => {
    if (isLastStep) {
      onClose();
      return;
    }
    setStepIndex((value) => Math.min(value + 1, TOUR_STEPS.length - 1));
  }, [isLastStep, onClose]);

  if (!open) return null;

  const highlightStyle = targetRect
    ? buildHighlightStyle(targetRect)
    : undefined;
  const overlaySegments = targetRect ? buildOverlaySegments(targetRect) : null;
  const popoverStyle = targetRect
    ? buildPopoverStyle(targetRect)
    : {
        top: VIEWPORT_PADDING,
        left: getViewportSize().width - POPOVER_WIDTH - VIEWPORT_PADDING,
        width: POPOVER_WIDTH,
      };

  return createPortal(
    <AnimatePresence>
      <>
        {overlaySegments ? (
          overlaySegments.map((segment, index) => (
            <motion.div
              key={index}
              className="fixed z-[10000] bg-black/30 backdrop-blur-[1px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={segment}
              onClick={onClose}
            />
          ))
        ) : (
          <motion.div
            className="fixed inset-0 z-[10000] bg-black/30 backdrop-blur-[1px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
        )}

        {highlightStyle && (
          <motion.div
            className="pointer-events-none fixed z-[10001] border-2 border-primary-6 shadow-[0_0_0_6px_color-mix(in_srgb,var(--color-primary-6)_20%,transparent)]"
            layout
            style={highlightStyle}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          />
        )}

        <motion.div
          {...POPUP_ANIMATION}
          className="fixed z-[10002] rounded-[14px] p-3"
          style={{ ...popoverStyle, ...popoverGlassStyle }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-primary-6">
              {t("tutorials.chrome.stepProgress", {
                current: stepIndex + 1,
                total: TOUR_STEPS.length,
              })}
            </span>
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6"
              aria-label={t("tutorials.chrome.close")}
              onClick={onClose}
            >
              <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
            </button>
          </div>

          <h3 className="mb-1.5 text-[14px] font-semibold leading-tight text-text-1">
            {t(`tutorials.codeEditor.steps.${currentStep.id}.title`)}
          </h3>
          <p className="mb-3 text-[12px] leading-[1.45] text-text-2">
            {t(`tutorials.codeEditor.steps.${currentStep.id}.body`)}
          </p>

          <div className="mb-3 flex gap-1.5">
            {TOUR_STEPS.map((step, index) => (
              <span
                key={step.id}
                className={`h-1.5 flex-1 rounded-full ${
                  index === stepIndex ? "bg-primary-6" : "bg-fill-3"
                }`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-2">
            <Button
              size="mini"
              variant="secondary"
              appearance="ghost"
              shape="circle"
              iconOnly
              icon={
                <HugeiconsIcon
                  icon={ArrowLeft02Icon}
                  data-icon="arrow-left"
                  size={13}
                />
              }
              disabled={isFirstStep}
              aria-label={t("tutorials.chrome.previous")}
              title={t("tutorials.chrome.previous")}
              onClick={goPrevious}
            />
            <span className="text-[11px] text-text-3">
              {t("tutorials.chrome.keyboardHint")}
            </span>
            <Button
              size="mini"
              variant="primary"
              shape="circle"
              iconOnly
              icon={
                isLastStep ? (
                  <HugeiconsIcon
                    icon={Tick01Icon}
                    data-icon="check"
                    size={13}
                  />
                ) : (
                  <HugeiconsIcon
                    icon={ArrowRight02Icon}
                    data-icon="arrow-right"
                    size={13}
                  />
                )
              }
              aria-label={
                isLastStep
                  ? t("tutorials.chrome.finish")
                  : t("tutorials.chrome.next")
              }
              title={
                isLastStep
                  ? t("tutorials.chrome.finish")
                  : t("tutorials.chrome.next")
              }
              onClick={goNext}
            />
          </div>
        </motion.div>
      </>
    </AnimatePresence>,
    document.body
  );
};

export default CodeEditorTour;
