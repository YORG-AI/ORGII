/**
 * WizardStepLayout Component
 *
 * Per-step frame for multi-step wizards.
 * Provides a content area + a pinned footer with step indicator and actions.
 *
 * The content area supports two modes:
 * - **Scroll mode** (default): `overflow-y-auto` for form-style content
 * - **Fill mode** (`browserOpen=true`): `flex flex-col overflow-hidden` so an
 *   embedded webview can fill the available height
 *
 * @example
 * ```tsx
 * <WizardStepLayout
 *   currentStep={1}
 *   totalSteps={2}
 *   actions={<Button variant="primary" onClick={onNext}>Next</Button>}
 * >
 *   {/* scrollable step content *\/}
 * </WizardStepLayout>
 * ```
 */
import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  PANEL_FOOTER_TOKENS,
} from "@src/modules/shared/layouts/blocks";

// ============================================
// Types
// ============================================

export interface WizardStepLayoutProps {
  /** Scrollable step content */
  children: React.ReactNode;
  /** Current step number (1-based) */
  currentStep: number;
  /** Total number of steps */
  totalSteps?: number;
  /** Extra content rendered on the footer left (e.g. status badge) */
  footerLeft?: React.ReactNode;
  /** Footer right content — typically Back / Next / Submit buttons */
  actions: React.ReactNode;
  /**
   * Cancel handler. When provided, a secondary "Cancel" button is
   * rendered as the first item in the footer actions row, replacing
   * the X close button that used to live in the WizardShell header
   * (the header chrome is now part of the workspace-header breadcrumb).
   */
  onCancel?: () => void;
  /** Override label for the auto-rendered Cancel button. */
  cancelLabel?: string;
  /** Test id for the auto-rendered Cancel button. */
  cancelTestId?: string;
  /** Hide the step indicator in the footer (step fraction only) */
  hideStepIndicator?: boolean;
  /** Remove default padding from the content area */
  noPadding?: boolean;
  /**
   * When true, content area switches from scroll to flex-fill mode.
   * Use this when an embedded browser/webview needs to fill the available height.
   */
  browserOpen?: boolean;
  /**
   * When true, skip the max-width content constraint and let children fill the
   * full available width. Use for split-panel layouts (e.g. workflow editor +
   * sidebar) that manage their own scrolling.
   */
  fillWidth?: boolean;
  /** Slot rendered between content and footer (e.g. pinned validation sections) */
  pinnedSection?: React.ReactNode;
  /** Suppress the footer border-top (use when pinnedSection already has one) */
  noBorderTop?: boolean;
  /** Match the Add Account footer: bg surface + centered content-width action row. */
  contentWidthFooter?: boolean;
}

// ============================================
// Component
// ============================================

const WizardStepLayout: React.FC<WizardStepLayoutProps> = ({
  children,
  currentStep,
  totalSteps = 2,
  footerLeft,
  actions,
  onCancel,
  cancelLabel,
  cancelTestId,
  hideStepIndicator = false,
  noPadding = false,
  browserOpen = false,
  fillWidth = false,
  pinnedSection,
  noBorderTop = false,
  contentWidthFooter = false,
}) => {
  const { t } = useTranslation("integrations");

  const scrollRef = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const isUserScrolling = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      savedScrollTop.current = el.scrollTop;
      isUserScrolling.current = true;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (isUserScrolling.current) {
      isUserScrolling.current = false;
      return;
    }

    if (Math.abs(el.scrollTop - savedScrollTop.current) > 1) {
      el.scrollTop = savedScrollTop.current;
    }
  });

  const footerContainerClass = noBorderTop
    ? PANEL_FOOTER_TOKENS.containerNoBorder
    : PANEL_FOOTER_TOKENS.container;

  const scrollContainerClass = fillWidth
    ? "min-h-0 flex-1 flex flex-col overflow-hidden"
    : browserOpen
      ? `min-h-0 flex-1 flex flex-col overflow-hidden${noPadding ? "" : " p-4"}`
      : `flex-1 overflow-y-auto scrollbar-overlay${noPadding ? "" : " px-4"}`;

  const innerWrapperClass = fillWidth
    ? "min-h-0 flex-1 flex flex-col overflow-hidden"
    : noPadding
      ? DETAIL_PANEL_TOKENS.contentWidth
      : `${DETAIL_PANEL_TOKENS.contentWidth} ${SECTION_GAP_CLASSES} pt-4 ${DETAIL_PANEL_TOKENS.contentScrollBottom}`;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className={scrollContainerClass}>
        <div className={innerWrapperClass}>{children}</div>
      </div>

      {pinnedSection}

      <div
        className={`${footerContainerClass} ${
          contentWidthFooter ? "relative z-10 bg-bg-2" : "justify-between"
        }`}
      >
        <div
          className={
            contentWidthFooter
              ? `${DETAIL_PANEL_TOKENS.contentWidth} flex items-center justify-between gap-2`
              : "contents"
          }
        >
          <div
            className={
              hideStepIndicator
                ? ""
                : `flex items-center gap-2 ${TYPOGRAPHY.sectionTitle}`
            }
          >
            {!hideStepIndicator && (
              <span className="text-text-1">
                {t("keyVault.stepLabel", {
                  current: currentStep,
                  total: totalSteps,
                })}
              </span>
            )}
            {footerLeft}
          </div>
          <div className="flex gap-2">
            {onCancel && (
              <Button
                variant="secondary"
                size="small"
                onClick={onCancel}
                data-testid={cancelTestId}
              >
                {cancelLabel ?? t("common:actions.cancel")}
              </Button>
            )}
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WizardStepLayout;
