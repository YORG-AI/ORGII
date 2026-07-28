/**
 * Orgii Components
 *
 * Public exports for Orgii-specific components
 */

export { BackgroundLayer } from "./BackgroundLayer";
export {
  ActivityTimestamp,
  ConnectedTimelineItem,
  TimelineCard,
  TimelineCardHeader,
  TimelineCopyButton,
  TimelineEventCard,
  TimelineStack,
} from "./ActivityTimeline";
export type { MarkdownEditorProps } from "./MarkdownEditor";
export {
  MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT,
  MarkdownContent,
  normalizeMarkdownContent,
} from "./MarkdownContent";
export type { MarkdownContentProps } from "./MarkdownContent";
export { default as RichMarkdownEditor } from "./RichMarkdownEditor";
export type {
  RichMarkdownEditorMode,
  RichMarkdownEditorProps,
  RichMarkdownEditorRef,
} from "./RichMarkdownEditor";
export { default as SaveableTextarea } from "./SaveableTextarea";
export type { SaveableTextareaProps } from "./SaveableTextarea";
export { GlobalSpotlightPortal } from "./GlobalSpotlightPortal";
export { SidebarSelector } from "./SidebarSelector";
