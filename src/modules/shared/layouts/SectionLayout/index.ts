/**
 * Section Layout Components
 *
 * 4 components for consistent structured pages
 * (settings, documentation, integrations, etc.)
 *
 * Hierarchy:
 *   <SectionHeading title="General" id="general">     page-level heading
 *     <SectionContainer title="Layout">                bordered container + optional sub-title
 *       <SectionRow label="Theme">                     label + control pair
 *         <Select style={SECTION_CONTROL_STYLE} />
 *       </SectionRow>
 *       {enabled && (
 *         <SectionRow label="Mode" indent>              indented sub-setting
 *           <Select style={SECTION_CONTROL_STYLE} />
 *         </SectionRow>
 *       )}
 *     </SectionContainer>
 *   </SectionHeading>
 *
 * Indentation (one level, pl-6):
 *   - SectionRow `indent` prop for all indented content
 *   - Use `showHeader={false}` for content-only indented blocks
 *   Do NOT hardcode pl-* values.
 */

// ── Components ──────────────────────────────────────────
export { default as SectionHeading } from "./Heading";
export type { SectionHeadingProps } from "./Heading";

export { default as SectionContainer } from "./Container";
export type { SectionContainerProps } from "./Container";

export { default as SectionRow } from "./Row";
export type { SectionRowProps } from "./Row";

export { default as SectionTable } from "./Table";
export type {
  SectionTableColumn,
  SectionTableProps,
  SectionTableRow,
} from "./Table";

export { default as CategoryRow } from "./CategoryRow";
export type { CategoryRowProps } from "./CategoryRow";

export { default as SectionTabSwitch } from "./TabSwitch";
export type { SectionTabSwitchProps } from "./TabSwitch";

export { default as ExpandableTableRow } from "./ExpandableTableRow";
export type { ExpandableTableRowProps } from "./ExpandableTableRow";

export { default as PathCopyOpenRow } from "./PathCopyOpenRow";
export type { PathCopyOpenRowProps } from "./PathCopyOpenRow";

export {
  SectionSidebarItem,
  SectionSidebarList,
  SectionSidebarSplit,
} from "./SidebarSplit";
export type {
  SectionSidebarItemProps,
  SectionSidebarListProps,
  SectionSidebarSplitProps,
} from "./SidebarSplit";

// ── Public tokens (for consumers) ───────────────────────
export {
  /** Apply to <Select> / <Input> / <NumberInput> controls: { width: 280, maxWidth: "100%" } */
  SECTION_CONTROL_STYLE,
  /** 280 — default control width in px */
  SECTION_CONTROL_WIDTH,
  /** 480 — container-query breakpoint value */
  SECTION_LAYOUT_BREAKPOINT,
  SECTION_CONTAINER_BASE_CLASSES,
  SECTION_CONTAINER_COLOR_CLASSES,
  /** "px-4" | "px-4 py-2" | "px-4 py-3" — padding variants for SectionContainer content */
  SECTION_PADDING,
  /** "pl-6" — left indent for sub-settings */
  SECTION_INDENT_CLASSES,
  /** Label typography classes */
  SECTION_LABEL_CLASSES,
  /** Light-weight label typography classes */
  SECTION_LABEL_LIGHT_CLASSES,
  /** Sub-heading inside a SectionContainer — used for "Section title" rows */
  SECTION_SUBHEADING_CLASSES,
  /** Description text classes */
  SECTION_DESCRIPTION_CLASSES,
  /** Right-side value text classes in SectionRow content */
  SECTION_VALUE_TEXT_CLASSES,
  /** Value text with success/warning/danger semantic colors */
  SECTION_VALUE_TEXT_SUCCESS_CLASSES,
  SECTION_VALUE_TEXT_WARNING_CLASSES,
  SECTION_VALUE_TEXT_DANGER_CLASSES,
  /** Get semantic value text class from remaining percentage (<10%=danger, <30%=warning, else=success) */
  getSectionValueTextSemanticClass,
  /** Path text with truncation (file/directory paths) */
  SECTION_PATH_TEXT_CLASSES,
  /** Small value text (e.g. "2 repos") */
  SECTION_VALUE_SMALL_CLASSES,
  /** Small secondary value text */
  SECTION_VALUE_SMALL_SECONDARY_CLASSES,
  /** Small muted value text */
  SECTION_VALUE_SMALL_MUTED_CLASSES,
  /** "flex items-center gap-2" — button group gap for SectionRow actions */
  SECTION_ACTION_GAP_CLASSES,
  /** "flex flex-col gap-3" — wrapper gap between section containers */
  SECTION_GAP_CLASSES,
} from "./tokens";
