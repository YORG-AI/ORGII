/**
 * Layout Components
 *
 * Public exports for shared layout components
 */

export { AppLayout } from "./AppLayout";
export type { AppLayoutProps } from "./AppLayout";
export { GlobalModals } from "./GlobalModals";
export { MainContentArea } from "./MainContentArea";
export { default as SplitViewLayout } from "./SplitViewLayout";
export type { SplitViewLayoutProps, SplitViewSubpage } from "./SplitViewLayout";
export { OnboardingLayout } from "./OnboardingLayout";
export type { OnboardingLayoutProps } from "./OnboardingLayout";
export { OnboardingLoadingVideo } from "./OnboardingLoadingVideo";
export {
  ONBOARDING_LOGIN_TOKENS,
  ONBOARDING_LOADING_VIDEO_FRAME_PX,
  ONBOARDING_LOADING_VIDEO_MAX_WIDTH_CLASS,
  ONBOARDING_LOADING_VIDEO_WIDTH_CLASS,
} from "./onboardingTokens";
export { default as Section } from "./Section";
export type { SectionProps } from "./Section";
export { default as SubpageLayout } from "./SubpageLayout";
export type { SubpageLayoutProps, SubpageAnchor } from "./SubpageLayout";
export { default as ConfigListItem } from "./ListDetailSubpage/ConfigListItem";
export type { ConfigListItemProps } from "./ListDetailSubpage/ConfigListItem";
