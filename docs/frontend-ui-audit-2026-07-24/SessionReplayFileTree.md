# Frontend UI Audit — Session Replay File Tree

**Files:** `src/modules/WorkStation/CodeEditor/SessionReplay/FileSidebar.tsx`, `src/modules/WorkStation/CodeEditor/SessionReplay/components/SimulatorTreePanel.tsx`
**Date:** 2026-07-24

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `SimulatorTreePanel.tsx:87` | `TreeRowBase` file/directory row | keep with reason | The surface continues to use the shared virtualized-tree row primitive for selection, indentation, naming, and click behavior. No new raw interactive element was added. | — |
| `SimulatorTreePanel.tsx:132` | `VirtualizedStickyTree` | keep with reason | Virtualization and sticky-directory behavior remain owned by the shared component rather than being recreated in Session Replay. | — |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `SimulatorTreePanel.tsx:97` | `text-[11px]` status badge | keep with reason | This is an existing optical micro-size for the one-character added/modified/deleted badge inside a 20px box; the change does not introduce a new arbitrary value. | — |
| `SimulatorTreePanel.tsx:137` | sticky background class | fixed | The sticky header previously used the shared component default, which could diverge from the active primary Sidebar surface. | The component now receives `stickyBgClass` from `usePrimarySidebarSurface`. |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `SimulatorTreePanel.tsx:97` | `h-5 w-5` status badge | keep with reason | The existing compact square aligns with the tree-row trailing slot and uses spacing-scale values plus semantic status color classes. | — |
| `FileSidebar.tsx:139-195` | sequence/path metadata | fixed | Chronology and parent-path text duplicated information already represented by the replay timeline and tree hierarchy, while crowding narrow Sidebar rows. | Removed `secondaryInfo` construction, storage, and rendering. |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `SimulatorTreePanel.tsx:87-107` | selectable tree row | keep with reason | Selection/click behavior remains delegated to the existing tree-row contract; removing decorative right-side metadata does not remove the file name, icon, status badge, or selection state. | — |

## D5 — Visual Patterns Observed

- Session Replay now follows the same primary Sidebar sticky-surface token path as sibling WorkStation trees.
- File rows keep canonical file names, icons, status badges, and hierarchy while dropping replay-order/path decoration.
- No new global component or token is required.

## Summary

- 2 fixes applied
- 4 patterns kept with documented reason
- 0 remaining abstraction candidates
