export interface NavigationSectionCollapseState {
  collapsibleSections: boolean;
  collapsedSectionIds: ReadonlySet<string>;
  sectionId: string;
}

/**
 * Section collapse state is presentation state and must remain authoritative
 * while the visible rows are filtered by search.
 */
export function isNavigationSectionCollapsed({
  collapsibleSections,
  collapsedSectionIds,
  sectionId,
}: NavigationSectionCollapseState): boolean {
  return collapsibleSections && collapsedSectionIds.has(sectionId);
}
