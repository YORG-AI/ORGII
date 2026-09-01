# Repository Spotlight UI audit

| Line                                                               | Element                   | Verdict          | Reason                                                                                                                                                        | Suggested change |
| ------------------------------------------------------------------ | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/scaffold/GlobalSpotlight/GlobalSpotlightPortal.tsx:24`        | Lazy Spotlight boundary   | keep with reason | Retains the existing `Suspense` boundary and Spotlight-owned dialog chrome while removing the non-visual status provider wrapper                              | None             |
| `src/scaffold/GlobalSpotlight/components/SpotlightItemRow.tsx:485` | Repository row right edge | keep with reason | Uses the existing generic `rightContent`, `rightLabel`, status-content, tag, shortcut, and disclosure slots; the bespoke Git badge branch no longer exists    | None             |
| `src/app/root/AppBootstrap.tsx:77`                                 | App provider composition  | keep with reason | Keeps the selected-repository `DeferredGitStatusProvider`, which belongs to Source Control, while removing the repo-list-only provider and its invisible work | None             |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.

Covered D1–D5. The change adds no raw controls, arbitrary values, hardcoded color/size values, interaction surface, or repeated visual pattern. Existing Spotlight design-system slots remain authoritative. Hook call-site edits in the Workspace and Team Collaboration components do not alter their rendered structure.

Verification: focused repo adapter, Workspace palette/dropdown, repo scope picker, and selected-repository Git derived-state suites passed; changed-file ESLint passed. No desktop UI control or screenshot capture was performed because Computer Use was not requested. Theme, viewport, and native focus behavior are unchanged but not visually re-verified.
