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

export { default as SectionDescription } from "./Description";

export { default as SectionContainer } from "./Container";

export { default as SectionRow } from "./Row";

export { default as CategoryRow } from "./CategoryRow";

export { default as SectionTabSwitch } from "./TabSwitch";

export { default as ExpandableTableRow } from "./ExpandableTableRow";

export { default as PathCopyOpenRow } from "./PathCopyOpenRow";

export {
  SectionSidebarItem,
  SectionSidebarList,
  SectionSidebarSplit,
} from "./SidebarSplit";

// ── Public tokens (for consumers) ───────────────────────
export {
  /** Apply to <Select> / <Input> / <NumberInput> controls: { width: 280, maxWidth: "100%" } */
  SECTION_CONTROL_STYLE,
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
  /** Shared icon/title/description/content hierarchy for content intros */
  SECTION_INTRO_TOKENS,
} from "./tokens";
