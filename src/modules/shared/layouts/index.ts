/**
 * Layout Components
 *
 * Public exports for shared layout components
 */

export { AppLayout } from "./AppLayout";
export { GlobalModals } from "./GlobalModals";
export { MainContentArea } from "./MainContentArea";
export {
  default as DetailPaneLayout,
  DetailPaneCloseAction,
  DetailPanePlaceholder,
  type DetailPaneCloseActionProps,
  type DetailPaneHeaderProps,
  type DetailPaneLayoutProps,
  type DetailPanePlaceholderProps,
} from "./DetailPaneLayout";
export {
  default as CompactListHeader,
  type CompactListHeaderProps,
} from "./CompactListHeader";
export { default as SplitViewLayout } from "./SplitViewLayout";
export { default as SplitListFullscreenButton } from "./SplitListFullscreenButton";
export {
  default as SplitListHeader,
  type SplitListHeaderProps,
} from "./SplitListHeader";
export {
  default as InboxListDetailLayout,
  INBOX_LIST_DETAIL_WIDTH,
  type InboxListDetailLayoutProps,
} from "./InboxListDetailLayout";
export { OnboardingLayout } from "./OnboardingLayout";
export { OnboardingLoadingVideo } from "./OnboardingLoadingVideo";
export {
  ONBOARDING_LOADING_VIDEO_MAX_WIDTH_CLASS,
  ONBOARDING_LOADING_VIDEO_WIDTH_CLASS,
} from "./OnboardingLoadingVideo";
export { default as Section } from "./Section";
export { default as SubpageLayout } from "./SubpageLayout";
