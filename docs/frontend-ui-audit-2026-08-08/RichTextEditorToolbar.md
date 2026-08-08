# Frontend UI Audit — Rich Text Editor Toolbar

## Scope

Inline Markdown formatting controls and the pull-request comment composer.

## Findings

| Line                          | Element                      | Verdict | Reason                                                                                                               | Suggested change                                                                        |
| ----------------------------- | ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `FloatingToolbar.tsx:180,219` | Toolbar group separators     | fix     | The vertical rules fragment a compact sequence of formatting controls without conveying a distinct mode or boundary. | Remove the separator elements.                                                          |
| `index.scss:470`              | Inline toolbar boundary      | fix     | The lower border creates an unnecessary line between the formatting controls and the editor input.                   | Keep the toolbar borderless while retaining the outer composer boundary and focus ring. |
| `FloatingToolbar.tsx:176-406` | Markdown formatting icons    | fix     | The 16px controls are visually heavy for the compact composer toolbar.                                               | Use a shared 14px icon size.                                                            |
| `index.scss:487`              | Mini formatting buttons      | fix     | The mini variant needs matching compact hit-area chrome for its smaller icons.                                       | Reduce mini controls from 24px to 22px.                                                 |
| `PrConversationTab.tsx:477`   | Pull-request composer footer | fix     | The footer top border adds a second internal divider in the same input surface.                                      | Remove the footer border while preserving its spacing and actions.                      |

## Verdict counts

- fix: 5
- keep with reason: 0
- abstract: 0

## Accessibility and visual-system notes

The outer composer boundary, focus-visible treatment, native button semantics,
aria labels, and hover/active states remain intact. The shared toolbar change
keeps inline Markdown editors visually consistent without introducing new
colors or interaction patterns.
