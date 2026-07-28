# Frontend UI Audit — Communication Replay

**Files:**

- `src/modules/WorkStation/Chat/Communication/index.tsx` (306 LOC)
- `src/modules/WorkStation/Chat/Communication/components/CommunicationCanvas.tsx` (50 LOC)
- `src/modules/WorkStation/Chat/Communication/components/CommunicationMessageContent.tsx` (44 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                                    | Element                                              | Verdict          | Reason                                                                                                                                    | Suggested change |
| --------------------------------------- | ---------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `index.tsx:194–207`                     | `PlanApprovalActions`                                | keep with reason | Pending-plan actions remain delegated to the existing design-system-backed component; the refactor introduced no raw interactive control. | —                |
| `CommunicationCanvas.tsx:24–48`         | `EventWrapper`, `Placeholder`, `LazySimulatorCanvas` | keep with reason | Canvas loading and framing reuse the established replay and placeholder primitives.                                                       | —                |
| `CommunicationMessageContent.tsx:25–42` | context and typography wrapper                       | keep with reason | The only raw element is a non-interactive layout host required for the selection ref and runtime typography bridge.                       | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                                    | Value                                                  | Verdict          | Reason                                                                                                               | Suggested change |
| --------------------------------------- | ------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `index.tsx:249–296`                     | `EDITOR_TAB_CANVAS_BG_CLASS`, shared replay components | keep with reason | The tab surface continues to use the existing workstation token; no arbitrary Tailwind color was introduced.         | —                |
| `CommunicationMessageContent.tsx:29–34` | runtime `--chat-*` style properties                    | keep with reason | These values are the existing user-configured chat typography bridge, not hardcoded project color or spacing values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                    | Value                                 | Verdict          | Reason                                                                                                                                                      | Suggested change |
| --------------------------------------- | ------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CommunicationMessageContent.tsx:29–34` | font sizes and line height from props | keep with reason | Values originate from persisted user settings; the only defaults (`13`, `1.6`) preserve the previous runtime behavior and are not Tailwind layout literals. | —                |

## D4 — Accessibility

| Line                            | Element                                    | Verdict          | Reason                                                                                                                                  | Suggested change |
| ------------------------------- | ------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `index.tsx:249–296`             | replay tabs, header and selection dropdown | keep with reason | Existing components retain ownership of keyboard, accessible-name, and dropdown semantics; no clickable non-semantic element was added. | —                |
| `CommunicationCanvas.tsx:30–38` | loading placeholder                        | keep with reason | Loading state remains rendered by the shared `Placeholder` surface with visible loading text.                                           | —                |

## D5 — Visual Patterns Observed

- The extracted components deliberately preserve existing replay primitives instead of creating parallel visual implementations.
- The runtime chat typography wrapper is domain-specific and appears once; it is not a new shared-component candidate.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates
