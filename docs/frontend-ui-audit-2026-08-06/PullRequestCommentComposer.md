# Frontend UI Audit — Pull Request Comment Composer

## Scope

Pull-request conversation comment/review composer placement and consistency
with the GitHub issue composer.

## Findings

| Line                        | Element                   | Verdict  | Reason                                                                                                                                                                                       | Suggested change                                                                                        |
| --------------------------- | ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PrConversationTab.tsx:344` | Composer placement        | fix      | Rendering the composer outside the conversation scroller pinned it to the panel and made PR discussions behave differently from issue threads.                                               | Keep the composer after the timeline inside `pr-conversation-scroll`.                                   |
| `PrConversationTab.tsx:352` | Composer shell and editor | abstract | Issues already establish the shared `ComposerShell` with a plain, inline-toolbar `RichMarkdownEditor`; PR comments should reuse those primitives while retaining PR-specific review actions. | Keep `ComposerShell` and the common editor treatment; pass PR review buttons through its footer layout. |

## Verdict counts

- fix: 1
- keep with reason: 0
- abstract: 1

## Accessibility and visual-system notes

The composer remains a labeled section with native buttons and preserves the
existing editor submit behavior. It uses shared input, border, focus, spacing,
and button primitives; no new arbitrary color or interaction tokens were
introduced.
