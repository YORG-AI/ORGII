/**
 * Orgii Components
 *
 * Public exports for Orgii-specific components
 */

export { BackgroundLayer } from "./BackgroundLayer";
export {
  ActivityHeaderActionButton,
  ActivityTimestamp,
  ConnectedTimelineItem,
  TimelineCard,
  TimelineCardHeader,
  TimelineCopyButton,
  TimelineEventCard,
  TimelineLoadingSkeleton,
  TimelineStack,
} from "./ActivityTimeline";
export type { ActivityHeaderActionButtonProps } from "./ActivityTimeline";
export type { MarkdownEditorProps } from "./MarkdownEditor";
export {
  MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT,
  MarkdownContent,
  normalizeMarkdownContent,
} from "./MarkdownContent";
export type { MarkdownContentProps } from "./MarkdownContent";
export { default as MarkdownTextareaEditor } from "./MarkdownTextareaEditor";
export { MarkdownEditorModeSwitch } from "./MarkdownTextareaEditor";
export type {
  MarkdownEditorMode,
  MarkdownEditorModeSwitchProps,
  MarkdownTextareaEditorProps,
  MarkdownTextareaEditorRef,
  MarkdownTextareaInsertOptions,
} from "./MarkdownTextareaEditor";
export { default as SaveableTextarea } from "./SaveableTextarea";
export type { SaveableTextareaProps } from "./SaveableTextarea";
export { GlobalSpotlightPortal } from "./GlobalSpotlightPortal";
export { SidebarSelector } from "./SidebarSelector";
