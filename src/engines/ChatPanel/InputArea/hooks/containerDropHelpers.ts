/**
 * Pure helpers for container-level drag-drop decisions.
 *
 * Extracted from useContainerDrag so the branching logic can be unit-tested
 * without mounting React or wiring up dnd-kit globals.
 */

/**
 * Returns true when a drop event should be routed to the internal
 * `handleDrop` handler (file-tree reference or generic file reference).
 *
 * Called after `event.preventDefault()` and `event.stopPropagation()` have
 * already been called — those are unconditional for all drops on the composer
 * container (see useContainerDrag) so that OS file drops never reach the
 * inner contenteditable host and trigger browser-default text insertion.
 */
export function isInternalDropType(
  types: string[],
  isInternalFileTreeActive: boolean,
  hasReferenceData: boolean
): boolean {
  return (
    isInternalFileTreeActive ||
    types.includes("application/x-file-reference") ||
    hasReferenceData
  );
}
