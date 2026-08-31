/**
 * OnboardingLayout
 *
 * Reusable card layout for onboarding/setup pages (split or single column).
 * Used by: LoginPage and SelectRepoPage
 *
 * Features:
 * - Centered card container
 * - Split: left column for primary content; right for secondary (repo list, etc.)
 * - Single column when `rightContent` is omitted/null (login)
 * - Tauri drag region support
 * - Responsive design
 */
import React from "react";

import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

const ONBOARDING_CARD_SHADOW =
  "shadow-[0_8px_32px_rgba(0,0,0,0.08),0_2px_8px_rgba(0,0,0,0.04)]";

export interface OnboardingLayoutProps {
  /** Content for the left column (primary - logo, actions) */
  leftContent: React.ReactNode;
  /** Content for the right column; omit or null for a single-column card (login). */
  rightContent?: React.ReactNode;
  /** Optional class name to add to the container */
  className?: string;
  /** Whether to show the layout as full-screen (like login) vs contained (like select-repo) */
  variant?: "fullscreen" | "contained";
  /** Size of the card container (only applies to contained variant) */
  size?: "default" | "large";
  /** Optional body class to add when mounted */
  bodyClass?: string;
  /** Optional class name for the card shell. */
  cardClassName?: string;
  /** Optional class name for the left panel in split layouts. */
  leftPanelClassName?: string;
  /** Optional style overrides for the left panel in split layouts. */
  leftPanelStyle?: React.CSSProperties;
  /** Optional class name for the right panel in split layouts. */
  rightPanelClassName?: string;
  /** Optional class name for the inner panel in single-column layouts. */
  singleColumnClassName?: string;
}

/**
 * OnboardingLayout provides a centered card for onboarding flows. Pass
 * `rightContent` for the repo-picker / walkthrough split layout; omit it for login.
 */
export const OnboardingLayout: React.FC<OnboardingLayoutProps> = ({
  leftContent,
  rightContent = null,
  className = "",
  variant = "contained",
  size = "default",
  bodyClass,
  cardClassName = "",
  leftPanelClassName = "",
  leftPanelStyle,
  rightPanelClassName = "",
  singleColumnClassName = "",
}) => {
  // Add/remove body class for special styling (e.g., hiding toolbar)
  React.useLayoutEffect(() => {
    if (bodyClass) {
      document.body.classList.add(bodyClass);
      return () => {
        document.body.classList.remove(bodyClass);
      };
    }
  }, [bodyClass]);

  // Base container classes
  const isFullscreen = variant === "fullscreen";
  const isLarge = size === "large" && !isFullscreen;
  const showRightPanel = rightContent != null;

  // Container classes
  const containerClasses = isFullscreen
    ? "fixed top-0 left-0 w-full h-screen z-[9999] overflow-hidden bg-bg-2 p-0"
    : isLarge
      ? "relative w-full h-full flex items-center justify-center p-3 overflow-auto"
      : "relative w-full h-full flex items-center justify-center p-6 overflow-auto";

  // Card classes (split vs single-column). Single-column uses the same outer
  // max width/height tokens as split so login keeps the previous card footprint.
  const cardClasses = !showRightPanel
    ? isFullscreen
      ? `flex h-full w-full max-h-none max-w-none items-center justify-center rounded-none border-none bg-bg-2 p-6 shadow-none`
      : isLarge
        ? `flex h-full max-h-[840px] w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl bg-bg-2 ${ONBOARDING_CARD_SHADOW}`
        : `flex h-full max-h-[560px] w-full flex-col overflow-auto rounded-2xl bg-bg-2 ${ONBOARDING_CARD_SHADOW} ${DETAIL_PANEL_TOKENS.contentMaxWidth}`
    : isFullscreen
      ? "flex h-full w-full max-h-none max-w-none flex-row rounded-none border-none shadow-none"
      : isLarge
        ? `flex h-full max-h-[840px] w-full max-w-[1400px] flex-row overflow-hidden rounded-2xl bg-bg-2 ${ONBOARDING_CARD_SHADOW}`
        : `flex h-full max-h-[560px] w-full flex-row overflow-hidden rounded-2xl bg-bg-2 ${ONBOARDING_CARD_SHADOW} ${DETAIL_PANEL_TOKENS.contentMaxWidth}`;

  // Left column classes (split layout only)
  const leftClasses = isFullscreen
    ? "mx-auto flex max-w-[400px] flex-1 flex-col items-center justify-center bg-transparent px-12 py-12 pb-16 text-center"
    : isLarge
      ? "flex w-[320px] flex-shrink-0 flex-col items-center justify-center gap-10 bg-bg-1 px-7 py-8"
      : "flex w-fit flex-shrink-0 flex-col items-center justify-center gap-4 bg-bg-1 p-6";

  // Right column classes (split layout only)
  const rightClasses = isFullscreen
    ? "flex flex-1 items-center justify-center bg-primary-1 px-12 py-12"
    : "flex flex-1 flex-col overflow-hidden bg-bg-2";

  const singleColumnInnerClasses = isFullscreen
    ? `flex w-full max-w-[420px] flex-col items-center justify-center gap-6 rounded-2xl bg-bg-1 px-10 py-10 ${ONBOARDING_CARD_SHADOW}`
    : isLarge
      ? "flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-10 overflow-y-auto px-7 py-8"
      : "flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-6";

  return (
    <div
      className={`${containerClasses} ${className}`.trim()}
      style={
        isFullscreen
          ? { borderRadius: "var(--border-radius-window)" }
          : undefined
      }
    >
      {!isFullscreen && (
        <div
          data-tauri-drag-region
          className="pointer-events-auto absolute inset-0 z-0"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          aria-hidden
        />
      )}
      {/* Drag region for Tauri window - only for fullscreen variant */}
      {isFullscreen && (
        <div
          data-tauri-drag-region
          className="pointer-events-auto absolute left-0 right-0 top-0 z-[100] h-[52px]"
          style={
            {
              WebkitAppRegion: "drag",
            } as React.CSSProperties
          }
        />
      )}

      {/* Card Container */}
      <div
        className={`relative z-10 ${cardClasses} ${cardClassName}`.trim()}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {showRightPanel ? (
          <>
            <div
              className={`${leftClasses} ${leftPanelClassName}`.trim()}
              style={leftPanelStyle}
            >
              {leftContent}
            </div>
            <div className={`${rightClasses} ${rightPanelClassName}`.trim()}>
              {rightContent}
            </div>
          </>
        ) : (
          <div
            className={`${singleColumnInnerClasses} ${singleColumnClassName}`.trim()}
          >
            {leftContent}
          </div>
        )}
      </div>
    </div>
  );
};

export default OnboardingLayout;
