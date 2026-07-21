# Shell Replay output frontend UI audit

**Primary files:** `src/components/ShellReplayOutput/index.tsx`, `index.scss`, `src/engines/SessionCore/replay/shellReplayRange.ts`, `shellReplayRequestGuard.ts`, Chat `TerminalBlock`, Session Replay `TerminalContent`, and the rendered replay E2E spec.

**Date:** 2026-07-19

> **Method note:** the `frontend-ui-audit` skill referenced by `AGENTS.md` is unavailable at both documented locations. This is a manual fallback using the repository's required dimensions: design-system reuse, Tailwind/token use, hardcoded presentation values, accessibility, and repeated visual patterns.

## D1 — Raw HTML vs design system

| Line / element                                              | Verdict          | Reason                                                                                                                                                                             | Suggested change                                     |
| ----------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ShellReplayOutput/index.tsx:405-414` command row           | keep with reason | Reuses the established `TerminalCommand` component and terminal settings rather than recreating prompt styling.                                                                    | None.                                                |
| `ShellReplayOutput/index.tsx:429-470` virtual terminal rows | keep with reason | Native `pre`/`span` elements are appropriate for selectable terminal text. The shared terminal surface hook supplies typography and colors; virtualization prevents unbounded DOM. | None.                                                |
| Chat `TerminalBlock` and right-pane `TerminalContent`       | abstract         | Both use one `ShellReplayOutput`; range loading, errors, bookmark clamping, and visual rows cannot drift between surfaces.                                                         | Keep future replay behavior in the shared component. |
| Removed legacy `TerminalPanel.tsx`                          | fix applied      | The duplicate implementation accumulated large strings and could diverge from Chat output behavior.                                                                                | None.                                                |

## D2 — Tailwind values vs tokens

| Line / element                                         | Verdict          | Reason                                                                                                                                | Suggested change                                                                                                  |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ShellReplayOutput/index.tsx:384-396` surface geometry | keep with reason | Simulator and compact Chat variants need different scroll geometry; colors and typography still come from semantic terminal settings. | Promote the Chat max-height to a shared terminal size token only if another compact transcript surface adopts it. |
| `ShellReplayOutput/index.scss` terminal variables      | abstract         | One set of CSS custom properties adapts both surfaces to user terminal font, size, spacing, selection, and background settings.       | None.                                                                                                             |
| Loading dots and shimmer                               | keep with reason | Uses semantic `primary-6` and existing shimmer utility; no raw color values are introduced.                                           | Respect reduced motion if the global utility does not already disable these animations.                           |

## D3 — Hardcoded sizes and colors

| Line / element                                     | Verdict          | Reason                                                                                                                             | Suggested change                                           |
| -------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `shellReplayRange.ts:3-10` byte and settle limits  | keep with reason | These are memory/performance contracts, not arbitrary visual styling: 256 KiB RPC, 1 MiB cache, 512 KiB raw window, 100 ms settle. | Keep synchronized with Rust acceptance tests when changed. |
| `ShellReplayOutput/index.tsx:306-307` row estimate | keep with reason | Derived from the configured terminal font size and line height, with an 18px safety floor for the virtualizer.                     | None.                                                      |
| stdout/stderr colors                               | abstract         | Uses `foreground` and `errorForeground` from `useTerminalSurfaceStyle`; no duplicate raw colors.                                   | None.                                                      |

## D4 — Accessibility

| Line / element                                       | Verdict          | Reason                                                                                                                                                  | Suggested change                                                                                                                     |
| ---------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ShellReplayOutput/index.tsx:389-404` scroll surface | keep with reason | `role="log"`, keyboard focus, command-derived label, normal selection, and continuous scrolling expose one coherent terminal rather than page controls. | Consider `aria-live="off"` explicitly if a screen reader announces every autoplay Snapshot despite the current static role behavior. |
| Range placeholders                                   | keep with reason | `aria-live="polite"` announces loading only when the user enters an uncached older/later region; initial background prefetch has no placeholder.        | None.                                                                                                                                |
| Incomplete/replay error                              | fix applied      | Keeps the Snapshot preview visible and now labels unavailable durable replay rather than silently implying complete history.                            | Localize the English fallback string when a dedicated translation key is added.                                                      |
| Playback controls E2E                                | keep with reason | The test clicks the production controls and reads rendered `innerText`; it does not pass by inspecting hidden `textContent`.                            | None.                                                                                                                                |

## D5 — Repeated visual patterns

| Line / element                     | Verdict          | Reason                                                                                                                                                                                                                                                 | Suggested change                       |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `ShellReplayRangeCache`            | abstract         | One process-wide LRU owns all replay strings and parsed visual rows; components retain only a key and scalar offsets.                                                                                                                                  | None.                                  |
| `ShellReplayRequestGuard`          | abstract         | Identity plus generation protects Chat and right-pane users from stale A→B→A range responses.                                                                                                                                                          | None.                                  |
| Snapshot preview then range window | keep with reason | Preview is immediate; the range replaces it only after the cursor settles. This preserves current playback feel and prevents an artificial page UI.                                                                                                    | None.                                  |
| E2E-only pane transition override  | keep with reason | WebKitWebDriver can freeze an occluded flex transition at zero width. The setup disables only the two layout transitions, while assertions still use visible content and real pointer controls. The behavior under test is replay, not pane animation. | Keep the override scoped to this spec. |

## Summary

- **fix candidates resolved: 2** — removed the duplicate terminal implementation and surfaced replay-load failure without hiding the bounded preview.
- **kept with documented reason: 10** — continuous terminal primitives, geometry, bounded constants, accessibility, loading, and deterministic rendered E2E setup.
- **abstracted: 5** — shared output component, terminal styling, process-wide LRU, request guard, and stdout/stderr color source.
- **systematic sweep candidates remaining: 0** — no second complete-log React state, pagination UI, raw color copy, or parallel replay request implementation remains.
