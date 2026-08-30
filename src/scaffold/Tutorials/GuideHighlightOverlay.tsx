import { AnimatePresence, motion } from "framer-motion";
import { useAtomValue, useSetAtom } from "jotai";
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import Button from "@src/components/Button";
import { getMaterialConfig } from "@src/components/Glass/config";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";
import {
  POPUP_ANIMATION,
  POPUP_SHADOW,
} from "@src/scaffold/shared/popupTokens";
import {
  clearGuideHighlightAtom,
  guideHighlightAtom,
} from "@src/store/ui/guideHighlightAtom";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { createAnimationFrameScheduler } from "./animationFrameScheduler";

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const TARGET_PADDING = 8;
const POPOVER_WIDTH = 320;
const VIEWPORT_PADDING = 16;
const POPOVER_ESTIMATED_HEIGHT = 168;
const AUTO_DISMISS_MS = 12_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getTargetRect(targetId: string): TargetRect | null {
  const selectors = [
    `[data-guide-target="${CSS.escape(targetId)}"]`,
    `[data-tour-target="${CSS.escape(targetId)}"]`,
  ];

  for (const selector of selectors) {
    for (const element of Array.from(
      document.querySelectorAll<HTMLElement>(selector)
    )) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    }
  }

  return null;
}

function buildHighlightStyle(rect: TargetRect): React.CSSProperties {
  return {
    top: rect.top - TARGET_PADDING,
    left: rect.left - TARGET_PADDING,
    width: rect.width + TARGET_PADDING * 2,
    height: rect.height + TARGET_PADDING * 2,
  };
}

function buildPopoverStyle(rect: TargetRect): React.CSSProperties {
  const { width: vw, height: vh } = getViewportSize();
  const hasRoomRight = vw - (rect.left + rect.width) > POPOVER_WIDTH + 36;
  const hasRoomLeft = rect.left > POPOVER_WIDTH + 36;
  const verticalCenter = clamp(
    rect.top + rect.height / 2 - POPOVER_ESTIMATED_HEIGHT / 2,
    VIEWPORT_PADDING,
    vh - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_PADDING
  );

  if (hasRoomRight) {
    return {
      top: verticalCenter,
      left: rect.left + rect.width + TARGET_PADDING + 12,
      width: POPOVER_WIDTH,
    };
  }

  if (hasRoomLeft) {
    return {
      top: verticalCenter,
      left: rect.left - POPOVER_WIDTH - TARGET_PADDING - 12,
      width: POPOVER_WIDTH,
    };
  }

  const hasRoomBelow = vh - (rect.top + rect.height) > POPOVER_ESTIMATED_HEIGHT;
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

const GuideHighlightOverlay: React.FC = () => {
  const highlight = useAtomValue(guideHighlightAtom);
  const clearHighlight = useSetAtom(clearGuideHighlightAtom);
  const { isDark } = useCurrentTheme();
  const material = getMaterialConfig(isDark, "thick");
  const borderColor = isDark
    ? "rgba(255, 255, 255, 0.10)"
    : "rgba(255, 255, 255, 0.24)";
  const [targetRect, setTargetRect] = useState<{
    targetId: string;
    rect: TargetRect | null;
  } | null>(null);

  useEffect(() => {
    if (!highlight) return;

    let observer: MutationObserver | null = null;
    let hasScrolledToTarget = false;

    const stopObserver = () => {
      observer?.disconnect();
      observer = null;
    };
    const startObserver = () => {
      if (observer || document.visibilityState === "hidden" || !document.body) {
        return;
      }
      observer = new MutationObserver(() => scheduler.schedule());
      observer.observe(document.body, { childList: true, subtree: true });
    };
    const updateRect = () => {
      const nextRect = getTargetRect(highlight.targetId);
      setTargetRect({ targetId: highlight.targetId, rect: nextRect });
      if (nextRect) {
        stopObserver();
        const element = document.querySelector<HTMLElement>(
          `[data-guide-target="${CSS.escape(highlight.targetId)}"],[data-tour-target="${CSS.escape(highlight.targetId)}"]`
        );
        if (!hasScrolledToTarget) {
          hasScrolledToTarget = true;
          element?.scrollIntoView({
            block: "center",
            inline: "center",
            behavior: "smooth",
          });
        }
      } else {
        startObserver();
      }
    };
    const scheduler = createAnimationFrameScheduler(updateRect, {
      requestFrame: window.requestAnimationFrame.bind(window),
      cancelFrame: window.cancelAnimationFrame.bind(window),
    });
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopObserver();
        return;
      }
      startObserver();
      scheduler.schedule();
    };

    startObserver();
    scheduler.schedule();
    window.addEventListener("resize", scheduler.schedule);
    window.addEventListener("scroll", scheduler.schedule, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const timeout = window.setTimeout(clearHighlight, AUTO_DISMISS_MS);

    return () => {
      scheduler.cancel();
      stopObserver();
      window.removeEventListener("resize", scheduler.schedule);
      window.removeEventListener("scroll", scheduler.schedule, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearTimeout(timeout);
    };
  }, [clearHighlight, highlight]);

  const rect =
    highlight && targetRect?.targetId === highlight.targetId
      ? targetRect.rect
      : null;
  const highlightStyle = useMemo(
    () => (rect ? buildHighlightStyle(rect) : undefined),
    [rect]
  );
  const popoverStyle = useMemo(
    () => (rect ? buildPopoverStyle(rect) : undefined),
    [rect]
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {highlight && rect && highlightStyle && popoverStyle && (
        <div className="pointer-events-none fixed inset-0 z-[10060]">
          <motion.div
            aria-hidden="true"
            className="fixed rounded-2xl border border-primary-5/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.42),0_0_26px_rgba(99,102,241,0.55)]"
            style={highlightStyle}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          />
          <motion.div
            className={`pointer-events-auto fixed rounded-2xl border p-4 text-text-1 ${POPUP_SHADOW}`}
            style={{
              ...popoverStyle,
              backdropFilter: `blur(${material.blur}px)`,
              WebkitBackdropFilter: `blur(${material.blur}px)`,
              background: material.background,
              borderColor,
            }}
            initial={POPUP_ANIMATION.initial}
            animate={POPUP_ANIMATION.animate}
            exit={POPUP_ANIMATION.exit}
            transition={POPUP_ANIMATION.transition}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {highlight.title && (
                  <div className="mb-1 text-[13px] font-semibold text-text-1">
                    {highlight.title}
                  </div>
                )}
                <div className="text-[12px] leading-5 text-text-2">
                  {highlight.message}
                </div>
              </div>
              <Button
                size="mini"
                variant="tertiary"
                appearance="ghost"
                icon={
                  <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
                }
                aria-label="Dismiss guide highlight"
                onClick={clearHighlight}
              />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
};

export default GuideHighlightOverlay;
