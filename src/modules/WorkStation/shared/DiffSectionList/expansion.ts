export interface DiffSectionExpansionOptions {
  flat: boolean;
  isFocused: boolean;
  collapseSignal: number;
  defaultCollapsed: boolean;
  sectionCount: number;
  collapseThreshold: number;
}

/** Resolve the initial expansion state without mounting a diff editor. */
export function getDefaultDiffSectionExpanded({
  flat,
  isFocused,
  collapseSignal,
  defaultCollapsed,
  sectionCount,
  collapseThreshold,
}: DiffSectionExpansionOptions): boolean {
  if (flat || isFocused) return true;
  if (collapseSignal > 0 || defaultCollapsed) return false;
  return sectionCount <= collapseThreshold;
}
