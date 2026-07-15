# Frontend UI Audit — TerminalAgentHoverCard

**File:** `src/engines/ChatPanel/components/TerminalAgentHoverCard/index.tsx` (119 LOC)  
**Date:** 2026-07-15  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line  | Element              | Verdict          | Reason                                                                                                                                                      | Suggested change |
| ----- | -------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 40–95 | status/activity rows | keep with reason | The component reuses `HoverCardPanel` and `HoverCardRow`; its raw spans/divs are non-interactive text layout, not replacements for a design-system control. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line  | Value              | Verdict          | Reason                                                                                                                                                   | Suggested change |
| ----- | ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 39–95 | hover-card styling | keep with reason | The new component uses semantic text tokens and the shared hover-card surface; it introduces no arbitrary Tailwind value or direct project CSS variable. | —                |

## D3 — Hardcoded Sizes / Colors

| Line               | Value                 | Verdict          | Reason                                                                                                                                 | Suggested change |
| ------------------ | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 43, 55, 75, 83, 91 | 13px Lucide row icons | keep with reason | This matches the established `HoverCardRow` icon scale used by `PrHoverCard` and `SessionHoverCard`; colors come from semantic tokens. | —                |

## D4 — Accessibility

| Line  | Element                       | Verdict          | Reason                                                                                                                                                                    | Suggested change |
| ----- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 40–95 | supplemental activity content | keep with reason | The hover card exposes readable text but owns no action; selecting the terminal and responding to approval remain available through the tab and Hermes TUI without hover. | —                |

## D5 — Visual Patterns Observed

- Pattern: title plus icon/text metadata rows — reuses the same `HoverCardPanel`/`HoverCardRow` composition as the existing PR and session hover cards; no third hover-card shell was introduced.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates

## Next-refactor candidates

- None from this component. If agent activity cards are later added for two more CLI agents, extract a provider-neutral formatter while retaining this shared hover-card shell.
