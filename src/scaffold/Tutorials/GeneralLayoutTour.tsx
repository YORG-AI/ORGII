import { AnimatePresence, motion } from "framer-motion";
import { useSetAtom } from "jotai";
import {
  Infinity,
  ArrowLeft,
  ArrowRight,
  Check,
  Monitor,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import Button from "@src/components/Button";
import { getMaterialConfig } from "@src/components/Glass/config";
import {
  POPUP_ANIMATION,
  POPUP_SHADOW,
} from "@src/scaffold/shared/popupTokens";
import { type StationMode, stationModeAtom } from "@src/store/ui/simulatorAtom";
import { type DockFilter, dockFilterAtom } from "@src/store/workstation";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { GENERAL_LAYOUT_TOUR_TARGETS } from "./generalLayoutTourConfig";

export {
  GENERAL_LAYOUT_TOUR_EVENT,
  GENERAL_LAYOUT_TOUR_TARGETS,
} from "./generalLayoutTourConfig";

type GeneralLayoutTourTarget =
  (typeof GENERAL_LAYOUT_TOUR_TARGETS)[keyof typeof GENERAL_LAYOUT_TOUR_TARGETS];

interface TourStep {
  id: string;
  target: GeneralLayoutTourTarget;
  title: string;
  body: string;
  dockFilter?: DockFilter;
  stationMode?: StationMode;
  demoStationModeSwitch?: boolean;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface GeneralLayoutTourProps {
  open: boolean;
  onClose: () => void;
}

const TOUR_STEPS: TourStep[] = [
  {
    id: "chat-panel",
    target: GENERAL_LAYOUT_TOUR_TARGETS.chatPanel,
    title: "Chat Panel",
    body: "This is where users have conversations with agents, review activity, and send follow-up instructions.",
  },
  {
    id: "station-mode-pill",
    target: GENERAL_LAYOUT_TOUR_TARGETS.stationModePill,
    title: "Switch station modes",
    stationMode: "my-station",
    demoStationModeSwitch: true,
    body: "Use this pill to switch station modes. Desktop means My Station, your workspace. Infinity means Agent Station, the agent activity view.",
  },
  {
    id: "dock",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dock,
    title: "Agent Station dock chrome",
    body: "The dock switches apps inside the station. The tour temporarily disables auto-hide so these controls stay visible.",
  },
  {
    id: "all-tabs",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dockAllTabs,
    title: "All Tabs",
    dockFilter: "all",
    body: "The first dock icon shows all open tabs together, regardless of which workstation app owns them.",
  },
  {
    id: "code-editor",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dockCodeEditor,
    title: "Code Editor",
    dockFilter: "code",
    body: "Use Code Editor for files, diffs, terminals, source control, and coding changes made during a session.",
  },
  {
    id: "browser",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dockBrowser,
    title: "Browser",
    dockFilter: "browser",
    body: "Use Browser for web pages, previews, app testing, and browser-based investigation alongside the chat.",
  },
  {
    id: "projects",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dockProjects,
    title: "Projects",
    dockFilter: "project",
    body: "Use Projects to track work items, plans, and project state connected to the current workspace.",
  },
];

const POPOVER_WIDTH = 320;
const VIEWPORT_PADDING = 16;
const TARGET_PADDING = 8;
const POPOVER_ESTIMATED_HEIGHT = 206;

function getTargetRect(target: GeneralLayoutTourTarget): TargetRect | null {
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

const GeneralLayoutTour: React.FC<GeneralLayoutTourProps> = ({
  open,
  onClose,
}) => {
  const { isDark } = useCurrentTheme();
  const setDockFilter = useSetAtom(dockFilterAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);

  const currentStep = TOUR_STEPS[stepIndex];
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === TOUR_STEPS.length - 1;

  useEffect(() => {
    if (!open || !currentStep.dockFilter) return;
    setStationMode("my-station");
    setDockFilter(currentStep.dockFilter);
  }, [currentStep.dockFilter, open, setDockFilter, setStationMode]);

  useEffect(() => {
    if (!open || !currentStep.stationMode) return;
    setStationMode(currentStep.stationMode);
  }, [currentStep.stationMode, open, setStationMode]);

  useEffect(() => {
    if (!open || !currentStep.demoStationModeSwitch) return;

    setStationMode("my-station");
    const showAgentStationId = window.setTimeout(() => {
      setStationMode("agent-station");
    }, 650);
    const showMyStationId = window.setTimeout(() => {
      setStationMode("my-station");
    }, 1450);
    const refreshRectId = window.setTimeout(() => {
      setTargetRect(getTargetRect(currentStep.target));
    }, 1500);

    return () => {
      window.clearTimeout(showAgentStationId);
      window.clearTimeout(showMyStationId);
      window.clearTimeout(refreshRectId);
    };
  }, [
    currentStep.demoStationModeSwitch,
    currentStep.target,
    open,
    setStationMode,
  ]);

  const updateTargetRect = useCallback(() => {
    if (!open) return;
    setTargetRect(getTargetRect(currentStep.target));
  }, [currentStep.target, open]);

  useEffect(() => {
    if (!open) return;

    const frameId = window.requestAnimationFrame(updateTargetRect);
    const retryId = window.setTimeout(updateTargetRect, 180);
    window.addEventListener("resize", updateTargetRect);
    window.addEventListener("scroll", updateTargetRect, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(retryId);
      window.removeEventListener("resize", updateTargetRect);
      window.removeEventListener("scroll", updateTargetRect, true);
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
              Step {stepIndex + 1} of {TOUR_STEPS.length}
            </span>
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6"
              aria-label="Close"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>

          <h3 className="mb-1.5 text-[14px] font-semibold leading-tight text-text-1">
            {currentStep.title}
          </h3>
          <p className="mb-3 text-[12px] leading-[1.45] text-text-2">
            {currentStep.body}
          </p>

          {currentStep.demoStationModeSwitch && (
            <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-border-2 bg-fill-1 p-2">
              <div className="flex items-center gap-2 rounded-md bg-fill-2 px-2 py-2 text-[11px] text-text-1">
                <span className="flex size-7 items-center justify-center rounded-md bg-primary-6 text-white">
                  <Monitor size={14} strokeWidth={1.8} />
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="font-semibold">Desktop</span>
                  <span className="text-text-3">My Station</span>
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-md bg-fill-2 px-2 py-2 text-[11px] text-text-1">
                <span className="flex size-7 items-center justify-center rounded-md bg-fill-3 text-text-1">
                  <Infinity size={14} strokeWidth={1.8} />
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="font-semibold">Infinity</span>
                  <span className="text-text-3">Agent Station</span>
                </span>
              </div>
            </div>
          )}

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
              icon={<ArrowLeft size={13} />}
              disabled={isFirstStep}
              aria-label="Previous step"
              title="Previous step"
              onClick={goPrevious}
            />
            <span className="text-[11px] text-text-3">
              Use ← / → or &lt; / &gt;
            </span>
            <Button
              size="mini"
              variant="primary"
              shape="circle"
              iconOnly
              icon={isLastStep ? <Check size={13} /> : <ArrowRight size={13} />}
              aria-label={isLastStep ? "Finish tour" : "Next step"}
              title={isLastStep ? "Finish tour" : "Next step"}
              onClick={goNext}
            />
          </div>
        </motion.div>
      </>
    </AnimatePresence>,
    document.body
  );
};

export default GeneralLayoutTour;
