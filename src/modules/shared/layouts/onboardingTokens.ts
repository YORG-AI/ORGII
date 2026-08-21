/** Square frame for the desktop onboarding art clips. */
export const ONBOARDING_LOADING_VIDEO_FRAME_PX = 350;

/**
 * Tailwind utilities matching {@link ONBOARDING_LOADING_VIDEO_FRAME_PX}.
 * Literal strings keep the utilities visible to Tailwind's class scanner.
 */
export const ONBOARDING_LOADING_VIDEO_WIDTH_CLASS = "w-[350px]";
export const ONBOARDING_LOADING_VIDEO_MAX_WIDTH_CLASS = "max-w-[350px]";

/** Shared sizing and composition tokens for authentication surfaces. */
export const ONBOARDING_LOGIN_TOKENS = {
  desktopColumnWidth: ONBOARDING_LOADING_VIDEO_WIDTH_CLASS,
  responsiveColumnWidth: `w-full ${ONBOARDING_LOADING_VIDEO_MAX_WIDTH_CLASS}`,
  contentStack: "flex flex-col items-center gap-6 text-center",
  actionStack: "flex w-full flex-col items-center gap-2",
  actionButton: "pointer-events-auto relative z-10 h-14 text-base font-medium",
} as const;
