/**
 * Workstation status bar — shared layout tokens (Tailwind class strings).
 *
 * Used by `base.tsx` and extension status bar items so height, padding, and
 * cluster gaps stay aligned when the bar layout changes.
 */
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";

/**
 * Semantic typography roles shared by every workstation status bar.
 *
 * The bar owns the 11px secondary-text scale and compact line height once;
 * consumers only opt into emphasis or numeric alignment. Keeping those roles
 * here prevents repo, branch, cursor, and extension items from rebuilding the
 * same typography with unrelated utility strings.
 */
export const STATUS_BAR_TYPOGRAPHY = {
  /** Base status-bar text: 11px, normal weight, compact line height. */
  root: `${TYPOGRAPHY.secondary} leading-none`,
  /** Default labels inherit the root's normal weight. */
  label: "font-normal",
  /** Workspace, branch, action, and count emphasis. */
  emphasis: "font-medium",
  /** Stable-width digits for cursor positions and counts. */
  numeric: "tabular-nums",
} as const;

export const STATUS_BAR_TOKENS = {
  /** Bar height (36px) */
  heightClass: "h-9",
  /** Shared semantic typography for the entire bar. */
  typographyClass: STATUS_BAR_TYPOGRAPHY.root,
  /** Outer horizontal padding of the bar (outside left/right clusters) */
  barPaddingClass: "px-2",

  /** Root bar row (before variant colors) */
  barShell: "relative flex w-full flex-shrink-0 items-center justify-between",
  /** Left cluster (includes gap between repo / branch / sync / etc.) */
  leftCluster: "flex h-full min-w-0 flex-1 items-center overflow-hidden",
  /** Right cluster (cursor / encoding / tools / etc.) */
  rightCluster: "flex h-full flex-shrink-0 items-center",
  /** Optional centered slot */
  centerCluster: "absolute left-1/2 flex h-full -translate-x-1/2 items-center",

  /**
   * Clickable segment — combine with hover/active classes.
   * Same inner layout as static segments; no shrink-0 so flex children behave.
   */
  button:
    "flex h-6 items-center self-center rounded-md gap-1.5 px-2 transition-colors",
  /**
   * Ghost (default) button variant — transparent background, hover fill.
   * Pairs with {@link StatusBarButton} base.
   */
  buttonGhost: SURFACE_TOKENS.hover,
  /**
   * Primary (filled) call-to-action button variant — brand fill, white
   * label. Matches the primary pill used in the selection dropdown so
   * status-bar CTAs read consistently.
   */
  buttonPrimary: `bg-primary-6 px-2.5 text-white hover:bg-primary-7 ${STATUS_BAR_TYPOGRAPHY.emphasis}`,
  /** Non-interactive block (icon + labels), e.g. indexing */
  segment:
    "flex h-full shrink-0 cursor-default select-none items-center gap-1.5 px-2",
  /** Text-only segment */
  text: "flex h-full shrink-0 cursor-default select-none items-center gap-1.5 px-2",

  /** Extension host items embedded in the bar */
  extensionRoot: "flex h-full min-h-0 items-center",
  extensionItem: `flex h-full min-h-0 shrink-0 items-center gap-1.5 px-2 transition-colors ${STATUS_BAR_TYPOGRAPHY.root}`,
} as const;
