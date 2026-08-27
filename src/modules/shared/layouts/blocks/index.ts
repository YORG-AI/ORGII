/**
 * Layout Blocks - Barrel Export
 *
 * Reusable layout building blocks for panels and pages
 */

export { default as BrowseCard } from "./BrowseCard";
export { default as HintWithInfo } from "./HintWithInfo";
export { default as SessionGroupPage } from "./SessionGroupPage";
export { default as SessionTable } from "./SessionTable";
export type { HintWithInfoProps } from "./HintWithInfo";
export type { SessionGroupPageProps } from "./SessionGroupPage";
export type {
  SessionTableColumnKey,
  SessionTableColumnOverrides,
  SessionTableItem,
  SessionTableProps,
} from "./SessionTable";
export {
  mapKanbanTaskToSessionTableItem,
  type SessionTableDateTimeLabelOptions,
} from "./sessionTableItem";
export type { BrowseCardProps } from "./BrowseCard";

export {
  CREATOR_BOTTOM_DOCK_PADDING_CLASS,
  CREATOR_MIDDLE_POSITION_STYLE,
  default as CreatorContentLayout,
} from "./CreatorContentLayout";
export type { CreatorContentLayoutProps } from "./CreatorContentLayout";

export { default as CollapsibleSection } from "./CollapsibleSection";
export type { CollapsibleSectionProps } from "./CollapsibleSection";
export { default as CollapsibleTableSection } from "./CollapsibleTableSection";
export type { CollapsibleTableSectionProps } from "./CollapsibleTableSection";

export { default as DetailPanelContainer } from "./DetailPanelContainer";
export type { DetailPanelContainerProps } from "./DetailPanelContainer";
export { default as DetailHeaderTabs } from "./DetailHeaderTabs";
export type { DetailHeaderTabsProps } from "./DetailHeaderTabs";
export { default as DetailTabStrip } from "./DetailTabStrip";
export type { DetailTabStripItem, DetailTabStripProps } from "./DetailTabStrip";
export { default as PersistentDetailTabPanel } from "./PersistentDetailTabPanel";
export type { PersistentDetailTabPanelProps } from "./PersistentDetailTabPanel";
export {
  default as WorkstationTrailSurface,
  WorkstationTrailBody,
  WorkstationTrailEmptyText,
  WorkstationTrailHeader,
  WorkstationTrailIconButton,
  WorkstationTrailSection,
  FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS,
  WORKSTATION_TRAIL_ICON_BUTTON_CLASS,
  WORKSTATION_TRAIL_RAIL_PADDING_CLASS,
  WORKSTATION_TRAIL_SURFACE_CLASS,
  WORKSTATION_TRAIL_WIDTH,
} from "./WorkstationTrailSurface";
export type {
  WorkstationTrailHeaderProps,
  WorkstationTrailSectionProps,
  WorkstationTrailSurfaceProps,
} from "./WorkstationTrailSurface";

export {
  CARD_ROW_TOKENS,
  COLLAPSIBLE_SECTION_TOKENS,
  DETAIL_PANEL_TOKENS,
  INFO_CARD_TOKENS,
  STAT_GRID_TOKENS,
} from "@src/config/detailPanelTokens";
export { SESSION_HISTORY_LIST_TOKENS } from "./sessionHistoryListTokens";
export { default as ScrollFadeContainer } from "./ScrollFadeContainer";
export { default as ScrollPreservation } from "./ScrollPreservation";
export {
  default as ScrollTrail,
  MAX_SCROLL_TRAIL_MARKERS,
  SCROLL_TRAIL_TARGET_SELECTOR,
  ScrollTrailTarget,
  getScrollTrailMarkerWidthClass,
  normalizeScrollTrailLabel,
  resolveActiveScrollTrailIndex,
  sampleScrollTrailIndices,
} from "./ScrollTrail";
export type {
  ScrollTrailAlignment,
  ScrollTrailPlacement,
  ScrollTrailProps,
  ScrollTrailTargetProps,
} from "./ScrollTrail";
export type { ScrollPreservationProps } from "./ScrollPreservation";
export type { ScrollFadeContainerProps } from "./ScrollFadeContainer";
export { SCROLL_FADE_TOKENS } from "../tokens/scrollFadeTokens";

export { default as InfoCard } from "./InfoCard";
export type { InfoCardProps, InfoCardRow } from "./InfoCard";
export { default as InlineInfoCard } from "./InlineInfoCard";
export type { InlineInfoCardProps } from "./InlineInfoCard";
export { InfoRow } from "./InfoRow";
export { default as InlineExpandedSplitCard } from "./InlineExpandedSplitCard";
export {
  default as InlineOptionCard,
  InlineOptionPill,
} from "./InlineOptionCard";
export type {
  InlineOptionCardProps,
  InlineOptionCardSection,
} from "./InlineOptionCard";
export {
  default as ToolInlineInfoCard,
  ToolInlineActionList,
  ToolInlineCompactRows,
} from "./ToolInlineInfoCard";
export type {
  ToolInlineActionRow,
  ToolInlineCompactRow,
  ToolInlineSectionConfig,
} from "./ToolInlineInfoCard";

export { default as PageBreadcrumb } from "./PageBreadcrumb";
export type { PageBreadcrumbProps } from "./PageBreadcrumb";

export { default as SettingsBreadcrumb } from "./SettingsBreadcrumb";
export type { SettingsBreadcrumbProps } from "./SettingsBreadcrumb";

export {
  BreadcrumbPillNav,
  BreadcrumbPillNavSeparator,
  BreadcrumbPillNavTrigger,
  BREADCRUMB_PILL_NAV_TOKENS,
} from "./BreadcrumbPillNav";
export type {
  BreadcrumbPillNavProps,
  BreadcrumbPillNavTriggerProps,
} from "./BreadcrumbPillNav";

export { default as PageHeader, PAGE_HEADER_TOKENS } from "./PageHeader";
export type { PageHeaderProps } from "./PageHeader";

export {
  default as InternalHeader,
  INTERNAL_HEADER_TOKENS,
} from "./InternalHeader";
export type { InternalHeaderProps } from "./InternalHeader";

export {
  default as PanelHeader,
  PANEL_HEADER_TOKENS,
  PanelHeaderSurfaceProvider,
  PanelRefreshButton,
} from "./PanelHeader";
export type {
  PanelHeaderBreadcrumb,
  PanelHeaderProps,
  PanelHeaderSurface,
} from "./PanelHeader";

export { default as PanelFooter, PANEL_FOOTER_TOKENS } from "./PanelFooter";
export type {
  PanelFooterProps,
  PanelFooterAction as PanelFooterActionConfig,
} from "./PanelFooter";

export { default as PanelFooterAction } from "./PanelFooterAction";

export { default as ListPanelSearch } from "./ListPanelSearch";
export type { ListPanelSearchProps } from "./ListPanelSearch";

export { default as ListPanelTabPillRow } from "./ListPanelTabPillRow";
export type { ListPanelTabPillRowProps } from "./ListPanelTabPillRow";

export { default as ListPanelScrollArea } from "./ListPanelScrollArea";
export type { ListPanelScrollAreaProps } from "./ListPanelScrollArea";

export { default as LoadingBar } from "./LoadingBar";
export type { LoadingBarProps } from "./LoadingBar";
