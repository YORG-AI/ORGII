/**
 * Sticky Row Tokens
 *
 * Shared class tokens for VS Code-style sticky header rows.
 * Ensures visual parity with TreeRowBase (same chevron size, padding, text style).
 *
 * Usage:
 * ```tsx
 * <div className={STICKY_ROW.row} style={stickyRowPadding(depth)} onClick={onClick}>
 *   <div className={STICKY_ROW.chevronBox}>
 *     {isExpanded
 *       ? <ChevronDown size={CHEVRON_SIZE} className={STICKY_ROW.chevronIcon} />
 *       : <ChevronRight size={CHEVRON_SIZE} className={STICKY_ROW.chevronIcon} />}
 *   </div>
 *   <span className={STICKY_ROW.name}>{node.name}</span>
 * </div>
 * ```
 */
import {
  CHEVRON_SIZE,
  TREE_INDENT_PX,
  TREE_PADDING_X,
  TREE_ROW_HOVER_BG_CLASS,
} from "@src/components/TreeRow";

const STICKY_ROW_DEFAULT_BG = "bg-workstation-bg";

export const STICKY_ROW = {
  /** Full row class including default bg. Pass stickyBgClass to override the bg. */
  row: `flex h-full cursor-pointer items-center gap-1.5 overflow-hidden ${STICKY_ROW_DEFAULT_BG} transition-colors ${TREE_ROW_HOVER_BG_CLASS}`,
  /** Row layout without any bg — use when the parent container supplies the bg. */
  rowBase: `flex h-full cursor-pointer items-center gap-1.5 overflow-hidden transition-colors ${TREE_ROW_HOVER_BG_CLASS}`,
  chevronBox: "flex h-3.5 w-3.5 shrink-0 items-center justify-center",
  chevronIcon: "text-text-3",
  /** Layout only — combine with a text color class (or use `name` for default) */
  nameBase: "min-w-0 flex-1 truncate text-[13px]",
  /** Layout + default text-text-2 color */
  name: "min-w-0 flex-1 truncate text-[13px] text-text-2",
} as const;

export { CHEVRON_SIZE };

export function stickyRowPadding(depth: number) {
  return {
    paddingLeft: `${depth * TREE_INDENT_PX + TREE_PADDING_X}px`,
    paddingRight: "8px",
  } as const;
}
