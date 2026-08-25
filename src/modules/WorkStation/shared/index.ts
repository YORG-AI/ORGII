/**
 * WorkStation Shared Components
 *
 * Components shared across CodeEditor, DatabaseManager, and Browser.
 */

// Layout shell
export { WorkStationShell } from "./WorkStationShell";
export type { WorkStationShellProps } from "./WorkStationShell";
export { WorkstationHeaderSectionSeparator } from "./WorkstationHeaderSectionSeparator";
export { WorkstationToolbarTooltip } from "./WorkstationToolbarTooltip";
export type { WorkstationToolbarTooltipProps } from "./WorkstationToolbarTooltip";

// Shell configuration
export {
  buildPrimarySidebarConfig,
  buildSecondaryPanelConfig,
  DEFAULT_PRIMARY_SIDEBAR_CONFIG,
} from "./WorkStationShell/config";
export type {
  PanelConfig,
  PrimarySidebarConfig,
  SecondaryPanelConfig,
  SecondaryPanelPosition,
} from "./WorkStationShell/config";

// Shared panel tab-bar chrome (position-aware tab header + position toggle)
export { default as PanelTabBar, PanelPositionToggle } from "./PanelTabBar";
export type {
  PanelTabBarProps,
  PanelTabBarTab,
  PanelTabIconName,
} from "./PanelTabBar";

export { TerminalInfoButton } from "./TerminalInfoButton";
export type { TerminalInfoButtonProps } from "./TerminalInfoButton";
export { TerminalNewSessionSplitButton } from "./TerminalNewSessionSplitButton";
export type { NewTerminalSessionOptions } from "./TerminalNewSessionSplitButton";

// Diff display
export { default as DiffFileSection } from "./DiffFileSection";
export type {
  DiffFileSectionData,
  DiffFileSectionProps,
} from "./DiffFileSection";
export { default as DiffSectionList } from "./DiffSectionList";
export type {
  DiffSectionListItem,
  DiffSectionListProps,
} from "./DiffSectionList";
export { default as DiffFileNavigationList } from "./DiffFileNavigationList";
export type {
  DiffFileNavigationItem,
  DiffFileNavigationListProps,
} from "./DiffFileNavigationList";
export {
  buildConsolidatedSessionReplayDiffSectionItems,
  buildSessionReplayDiffSectionItems,
  type SessionReplayDiffEntryLike,
  type SessionReplayDiffSectionItem,
} from "./DiffSectionList/sessionReplaySections";

// Count badges (for diagnostic counts: errors, warnings, etc.)
export { CountBadge } from "./CountBadge";
export type { CountBadgeProps, CountVariant } from "./CountBadge";

// Primary sidebar layout
export {
  CollapsibleSection,
  PrimarySidebarLayout,
  PrimarySidebarLayoutWithSections,
} from "./PrimarySidebarLayout";
export type {
  CollapsibleSectionProps,
  PanelSection,
  PrimarySidebarLayoutProps,
  PrimarySidebarLayoutWithSectionsProps,
  PrimarySidebarTab,
} from "./PrimarySidebarLayout";

// Reusable sidebar modules (tab-specific sidebar substrate) are NOT
// re-exported here on purpose: `./SidebarModules/index.ts` evaluates the
// Terminal/Benchmark/SourceControl tab sidebars (module-side-effect
// registrations), which pulls xterm + engines/TerminalCore into every
// consumer of this barrel. Hosts import from
// `@src/modules/WorkStation/shared/SidebarModules` directly (see
// CodeEditor/index.tsx, which also carries the side-effect import).

// Property editor components
export {
  ColorInput,
  EditableField,
  LinkedInputPair,
  SpacingBottom,
  SpacingLeft,
  SpacingRight,
  SpacingTop,
} from "./PropertyEditor";
export type {
  ColorInputProps,
  EditableFieldProps,
  LinkedInputPairProps,
} from "./PropertyEditor";

// Tab bar
export {
  TabBar,
  TAB_BAR_HEIGHT,
  MAX_VISIBLE_TABS,
  STATUS_LABELS,
} from "./TabBar";
export type { WorkStationTab, TabBarProps } from "./TabBar";
export { TabBarTrailingIconButton } from "./TabBar/components/TabBarTrailingIconButton";
export type { TabBarTrailingIconButtonProps } from "./TabBar/components/TabBarTrailingIconButton";
export { StationTabBarLeading } from "./StationTabBarLeading";
export { TabBarLeadingLayout } from "./TabBarLeadingLayout";

// File header with breadcrumb navigation (relocated to shared)
export { default as FileHeader } from "@src/modules/shared/components/FileHeader";
export type {
  FileHeaderProps,
  DiffViewMode,
  ToggleOption,
} from "@src/modules/shared/components/FileHeader";

export { default as GitFileList } from "./GitFileList";
export type { GitFileListProps, FileListViewMode } from "./GitFileList";
export {
  gitFileListWidthAtom,
  GIT_FILE_LIST_DEFAULT_WIDTH,
  GIT_FILE_LIST_MAX_WIDTH,
  GIT_FILE_LIST_MIN_WIDTH,
} from "./GitFileList/widthAtom";

// Resize handles
export {
  HorizontalResizeHandle,
  VerticalResizeHandle,
} from "@src/scaffold/Resize";

// Floating bar (unsaved changes, review next, etc.)
export { FloatingBar, UnsavedChangesBar } from "./UnsavedChangesBar";
export type {
  FloatingBarProps,
  UnsavedChangesBarProps,
} from "./UnsavedChangesBar";

// Quick actions panel — types only. The component (framer-motion) is not
// re-exported: nothing imports it through this barrel, and a value export
// here would drag the animation stack into every barrel consumer.
export type { QuickAction, QuickActionsPanelProps } from "./QuickActionsPanel";

// No tabs placeholder (with quick actions)
export { NoTabsPlaceholder } from "./NoTabsPlaceholder";
export type {
  NoTabsPlaceholderProps,
  PlaceholderIcon,
} from "./NoTabsPlaceholder";

export {
  useSimulatorAwaitingAgentCaption,
  useSimulatorPlaceholderActions,
} from "./useSimulatorPlaceholderActions";
export type { SessionReplayPlaceholderMode } from "./useSimulatorPlaceholderActions";

// Session-replay shared building blocks (tab bar, sidebar selection helpers, …)
export {
  ReplayTabBar,
  ReplayShellLayout,
  ReplayShellPlaceholder,
  SimulatorReplayChrome,
  SimulatorWorkstationTabHeader,
  capNewestWithActive,
  gateByActiveKind,
  MAX_REPLAY_TABS,
  mergeNewestFirstByTimestamp,
  useReplayShell,
  type ActiveSelectionKind,
  type KnownReplayTabKind,
  type ReplayShellLayoutProps,
  type ReplayShellPlaceholderProps,
  type ReplayShellWorkstationConfig,
  type ReplayTab,
  type ReplayTabBarProps,
  type SimulatorReplayChromeProps,
  type SelectionByKind,
  type TimestampedReplayTab,
  type UseReplayShellResult,
} from "./SessionReplay";

// Station-mode chip + product-bound app-switcher wrappers.
// The shared chip view (AppSwitcherChip), its dropdown panel, the
// AppSwitcherMenuItem/AppSwitcherChipData types, and the
// useSimulatorAppSwitcher data hook are internal to AppSwitcherWrappers and
// are no longer re-exported here — nothing outside imports them from the
// barrel. SimulatorTabBarLeading is imported directly from
// ./AppSwitcherWrappers by SessionReplay, so it is not re-exported either.
export { StationModeChip } from "./StationModeChip";
export {
  SimulatorAgentChip,
  WorkStationTabBarLeading,
} from "./AppSwitcherWrappers";

// Sidebar collapse toggle (lives in tab bar trailing slots)
export {
  SidebarToggleButton,
  SimulatorSidebarToggleButton,
  WorkStationSidebarToggleButton,
} from "./SidebarToggleButton";
export type { SidebarToggleButtonProps } from "./SidebarToggleButton";

// Tab bar trailing controls (per-app panel toggles)
export {
  TabBarBottomPanelToggle,
  TabBarDevToolsToggle,
} from "./TabBarTrailingControls";

// Header and typography tokens (shared dimensions, button styles, class strings)
export {
  BUTTON_SIZE,
  COUNT_BADGE,
  getCountBadgeSizeClass,
  BUTTON_VARIANT,
  EDITOR_TAB_CANVAS_BG_CLASS,
  WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS,
  HEADER_BUTTON,
  HEADER_CLASSES,
  HEADER_HEIGHT,
  HEADER_ICON_SIZE,
  SECTION_ACTION_BUTTON,
  TYPOGRAPHY,
} from "./tokens";

// Text tokens (i18n keys for Workstation)
export { HUMANTOOLS_TEXT_KEYS } from "./textTokens";

// Status bars
export {
  BaseStatusBar,
  BrowserStatusBar,
  EditorStatusBar,
  StatusBarButton,
  StatusBarDivider,
  StatusBarRenderer,
  StatusBarText,
} from "./StatusBar";

export type {
  BaseStatusBarProps,
  BrowserStatusBarProps,
  CommitInfo,
  CursorPosition,
  EditorStatusBarProps,
  StatusBarButtonProps,
  StatusBarDividerProps,
  StatusBarTextProps,
} from "./StatusBar";
