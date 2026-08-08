# Frontend UI Audit — Creator Middle Layout

## Scope

The default start-page placement for Session, Work Item, and Project creators,
including both manual and Agent composer variants. Non-start-page detail and
embedded creation layouts remain fill-height by design.

## Findings

| Line                                                                  | Element                              | Verdict          | Reason                                                                                                                                                                          | Suggested change                                                                             |
| --------------------------------------------------------------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ChatPanelStartPage.tsx:430`                                          | Session creator middle placement     | fix              | Session used a local `items-center justify-center` wrapper while Work Item and Project used a separate launcher abstraction.                                                    | Route Session through the same shared creator layout.                                        |
| `ChatPanelStartPage.tsx:423`                                          | Project launcher height chain        | fix              | The More tab inserted a non-flex wrapper between its full-height stage and Project's flexing creator root, so the shared middle layout had no definite height to center within. | Render the Project launcher directly as the More stage's flex child.                         |
| `CreateProjectView/index.tsx:425`, `CreateWorkItemView/index.tsx:335` | Project/Work Item launcher placement | abstract         | The middle-position primitive was nested under Project Manager even though Session needs the identical behavior.                                                                | Move the fill-or-middle layout to the neutral shared layout layer.                           |
| `CreatorContentLayout.tsx:10`                                         | Shared creator placement             | abstract         | All three creator domains need one source of truth for fill height, scrolling, midpoint alignment, and viewport clearance.                                                      | Use one `CreatorContentLayout` across Session, Work Item, and Project.                       |
| `CreatorContentLayout.tsx:27`, `CreateComposerScaffold.tsx:83`        | Centered top-only spacing            | fix              | Centered Project and Work Item composers used `pt-6`, shifting their visible composer below the true midpoint.                                                                  | Put symmetric `py-6` clearance on the shared middle frame and remove centered child offsets. |
| `CreateProjectView/index.tsx:425`, `CreateWorkItemView/index.tsx:335` | Non-start-page creator layout        | keep with reason | Project Manager tabs and embedded detail surfaces need fill-height editor behavior rather than start-page centering.                                                            | Keep the shared layout's non-centered mode as the explicit fallback.                         |

## Verdict counts

- fix: 3
- keep with reason: 1
- abstract: 2

## Accessibility and visual-system notes

The change only consolidates layout ownership. Focus order, labels, buttons,
menu semantics, maximum content widths, and responsive scrolling remain
unchanged. Symmetric vertical clearance prevents clipping at short viewport
heights without biasing the creator below center.
