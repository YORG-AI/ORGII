# Frontend UI Audit — DOMTreeContent

**Files:**

- `src/modules/WorkStation/Browser/Panels/BrowserSecondaryPanel/components/WebDevTools/components/DOMTreeContent/index.tsx` (78 LOC)
- `src/modules/WorkStation/Browser/Panels/BrowserSecondaryPanel/components/WebDevTools/components/DOMTreeContent/DOMTreeList.tsx` (92 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                    | Element                          | Verdict          | Reason                                                                                                                                                                  | Suggested change |
| ----------------------- | -------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `index.tsx:31–59`       | loading/error/empty states       | keep with reason | All state surfaces use the shared `Placeholder` component; the coordinator introduces no raw interactive control.                                                       | —                |
| `DOMTreeList.tsx:64–89` | virtualized and plain list hosts | keep with reason | Raw divs are non-interactive scroll/measurement hosts required by Virtuoso and native `scrollIntoView`; row interaction remains in the existing DOM tree row component. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line            | Value | Verdict          | Reason                                                                                            | Suggested change |
| --------------- | ----- | ---------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| all changed TSX | none  | keep with reason | The extracted coordinator/list use only standard layout utilities and existing TreeRow constants. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                    | Value                       | Verdict          | Reason                                                                                                                                      | Suggested change |
| ----------------------- | --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `DOMTreeList.tsx:72–75` | overscan / viewport buffers | keep with reason | These numeric values configure Virtuoso rendering behavior, not visual CSS dimensions; they preserve the established virtualization window. | —                |

## D4 — Accessibility

| Line                    | Element                     | Verdict          | Reason                                                                                                                                                                             | Suggested change |
| ----------------------- | --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `DOMTreeList.tsx:40–56` | `DOMTreeNodeRow` delegation | keep with reason | The refactor preserves the existing row interaction contract and adds no new click target. Row-level keyboard semantics remain a separate concern in the unchanged leaf component. | —                |
| `index.tsx:31–59`       | state feedback              | keep with reason | Loading, error, and empty states retain visible shared Placeholder feedback.                                                                                                       | —                |

## D5 — Visual Patterns Observed

- The list extraction preserves the established dual rendering strategy: Virtuoso above the threshold, native scrolling below it.
- No new visual primitive or duplicate styling pattern was introduced.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
