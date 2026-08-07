# Frontend UI Audit: Session Round Message Footer

## Scope

- `src/components/MessageFooter/index.tsx`
- `src/engines/ChatPanel/blocks/AgentMessageBlock/index.tsx`
- `src/engines/ChatPanel/ChatItems/AgentChatItemDefault.tsx`
- `src/engines/ChatPanel/events/stream/agent-message/index.tsx`
- `src/engines/ChatPanel/ChatHistory/ActivityRouter.tsx`

The configured `frontend-ui-audit` skill file was not available at either path documented in `AGENTS.md`, so this pass applies the repository's stated audit dimensions directly: shared-component usage, design-token consistency, arbitrary Tailwind values, accessibility basics, and visual-pattern duplication.

## Findings

| Line                                                           | Element                        | Verdict          | Reason                                                                                                                                                   | Suggested change |
| -------------------------------------------------------------- | ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/components/MessageFooter/index.tsx:18`                    | `MessageFooterTimestamp`       | keep with reason | Uses a semantic `<time>` element, accepts an ISO `dateTime`, and centralizes the muted metadata treatment for reuse.                                     | None.            |
| `src/components/MessageFooter/index.tsx:40`                    | `MessageFooterCopyButton`      | keep with reason | Uses a native button, localized visible and accessible labels, existing color tokens, and the established copied-toast behavior.                         | None.            |
| `src/components/MessageFooter/index.tsx:79`                    | `MessageFooter`                | keep with reason | Abstracts the repeated timestamp/action footer layout without owning session or round state, so other message surfaces can reuse it.                     | None.            |
| `src/engines/ChatPanel/blocks/AgentMessageBlock/index.tsx:114` | final-message footer selection | keep with reason | Reuses the existing turn context's final-assistant index and suppresses the footer while streaming, avoiding DOM-order heuristics and duplicate actions. | None.            |
| `src/engines/ChatPanel/ChatItems/AgentChatItemDefault.tsx:64`  | legacy corner-copy gate        | keep with reason | Preserves the existing copy affordance for other hosts while allowing session history to opt into the new below-message primitive.                       | None.            |

## Summary

- Fix: 0
- Keep with reason: 5
- Abstract: 0
- Multi-file sweep candidates: 0

No arbitrary color values, duplicate session-footer implementations, or unlabeled interactive controls were found in the changed UI surface.
