/**
 * Active-selection gating for multi-section replay sidebars.
 *
 * Some session-replay sidebars (currently the Code Editor's `FileSidebar`)
 * carry several independent `selectedXxxEventId` values — one per op kind —
 * and render each in its own tree section. Only ONE of those selections is
 * actually mirrored in the main pane (CodePanel) at any given moment, so we
 * want exactly one section to show the `primary-1` row fill and the rest to
 * appear un-selected, even if they still remember a prior click.
 *
 * This module owns the type + the helper that does that gating so the sidebar
 * component itself stays free of per-kind ternaries, and any future multi-kind
 * sidebar can opt in with a single import.
 *
 * The blue "agent cursor" dot is a separate signal (driven by `agentSelectedIds`
 * in the sidebar) and is NOT affected by this module.
 */

/** Kinds of selection that can drive a replay sidebar's main pane. */
export type ActiveSelectionKind = "file" | "explore" | "terminal" | "tool";

/**
 * Given a map of `kind → selectedEventId` and the currently-active kind,
 * return the same map with every non-active entry nulled out. Callers wire
 * each returned id straight into the matching section's `selectedId` prop.
 *
 * Pure, allocation-free-ish, no React machinery — we don't need reactivity
 * here, we just need a 4-way switch expressed in one place.
 *
 * @example
 *   const gated = gateByActiveKind(
 *     { file: fileId, explore: searchId, terminal: shellId, tool: toolId },
 *     "file"
 *   );
 *   // => { file: fileId, explore: null, terminal: null, tool: null }
 */
export function gateByActiveKind(
  selections: Record<ActiveSelectionKind, string | null>,
  activeKind: ActiveSelectionKind
): Record<ActiveSelectionKind, string | null> {
  return {
    file: activeKind === "file" ? selections.file : null,
    explore: activeKind === "explore" ? selections.explore : null,
    terminal: activeKind === "terminal" ? selections.terminal : null,
    tool: activeKind === "tool" ? selections.tool : null,
  };
}
