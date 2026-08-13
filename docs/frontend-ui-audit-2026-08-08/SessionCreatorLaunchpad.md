# Frontend UI Audit — Session Creator Launchpad

**Files:** `src/components/SelectorPill/index.tsx`, `src/components/SegmentedTextPill/index.tsx`, `src/components/PropertyField/PropertyDropdownDirection.tsx`, `src/components/PropertyField/PropertyDropdownField.tsx`, `src/components/PropertyField/PropertyFieldEditable.tsx`, `src/features/SessionCreator/components/CliLaunchModeSwitch.tsx`, `src/features/SessionCreator/components/SessionInfoLine.tsx`, `src/features/SessionCreator/variants/ChatPanel/SessionCreatorAgentHero.tsx`, `src/features/SessionCreator/variants/ChatPanel/SessionCreatorChatPanelView.tsx`, `src/engines/ChatPanel/ChatPanelStartPage.tsx`, `src/engines/ChatPanel/ChatPanelEmptyContent.tsx`, `src/modules/shared/layouts/blocks/CreatorContentLayout.tsx`, `src/modules/ProjectManager/shared/components/CreateComposerScaffold.tsx`, `src/modules/ProjectManager/shared/components/ProjectContentEditor/index.tsx`, `src/modules/ProjectManager/WorkItems/components/CreateWorkItemView/index.tsx`, `src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu/index.tsx`, `src/modules/ProjectManager/Projects/components/CreateProjectView/index.tsx`, `src/scaffold/GlobalSpotlight/palettes/WorkspacePalette/WorkspaceDropdown.tsx`, `src/scaffold/GlobalSpotlight/palettes/BranchPalette/BranchDropdown.tsx`
**Date:** 2026-08-08

## D1 — Raw HTML vs Design System

| Line                                                          | Element                              | Verdict          | Reason                                                                                                                                                                                       | Suggested change |
| ------------------------------------------------------------- | ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionCreatorAgentHero.tsx:33–58`                           | Centered agent question and selector | keep with reason | The question is static text and the selector uses the shared ghost `SelectorPill`, preserving the existing category-picker behavior and focus semantics without adding a background surface. | —                |
| `ChatPanelStartPage.tsx:137–208`                              | Shared suggestion-card grid          | keep with reason | The middle presentation follows the Codex reference with vertical icon/text cards, while the compact footer presentation remains available for non-creator More views.                       | —                |
| `CreateComposerScaffold.tsx:117–123`                          | Project and Work Item settings row   | keep with reason | Both manual-create surfaces use the same shared scaffold, so placing the property pills above the editor keeps their formatting and order identical.                                         | —                |
| `SessionCreatorChatPanelView.tsx:197–244`                     | Agent-assisted creation action row   | keep with reason | Session, Work Item, and Project reuse one setup-actions element; Launchpad placement above the composer is derived directly from the page layout.                                            | —                |
| `CreatorContentLayout.tsx:19–45`                              | Creator page shell                   | keep with reason | One shared shell owns the centered Manual prompt/pills slot and the bottom input slot; Agent launchers fill it with the equivalent Launchpad composition.                                    | —                |
| `SegmentedTextPill/index.tsx`                                 | Agent/Manual and GUI/TUI controls    | keep with reason | One shared native-button segmented control keeps both mode selectors visually identical and lets the creator place Agent/Manual in the same setup row instead of the page tabs.              | —                |
| `CreateComposerScaffold.tsx`, `PropertyDropdownDirection.tsx` | Bottom-row menu direction            | keep with reason | A scoped provider makes every Work Item and Project property menu open upward without changing dropdown behavior in non-creator property panels.                                             | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                                                          | Value                                            | Verdict          | Reason                                                                                                                                                                | Suggested change |
| ------------------------------------------------------------- | ------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionCreatorAgentHero.tsx:39–54`                           | `text-[18px]`, `sm:text-[20px]`                  | keep with reason | The smaller, regular-weight prompt scale is shared by the prompt and selected-agent text, keeping the inline sentence visually balanced without clipping long labels. | —                |
| `ChatPanelStartPage.tsx:129–195`                              | `min-h-[84px]`, `max-w-[400px]`, `max-w-[600px]` | keep with reason | These sizes reproduce compact Codex-style card proportions and keep two- and three-card groups centered without stretching across the page.                           | —                |
| `SessionCreatorChatPanelView.tsx`, `CreatorContentLayout.tsx` | `clamp(9rem, 42%, calc(100% - 20rem))`           | keep with reason | The shared optical-center position sits above mathematical center and reserves a 20rem bottom region so the prompt/cards cannot collide with the docked composer.     | —                |
| `SegmentedTextPill/index.tsx`                                 | `h-[28px]`                                       | keep with reason | The shared 28px segmented pill preserves the established GUI/TUI control height while applying that exact geometry to Agent/Manual.                                   | —                |

## D4 — Accessibility

| Line                                | Element        | Verdict          | Reason                                                                                                                                                                    | Suggested change |
| ----------------------------------- | -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionCreatorAgentHero.tsx:42–54` | Agent selector | keep with reason | The shared selector remains a keyboard-operable native button with its existing `aria-expanded` state; removing the description does not remove a required control label. | —                |
| `SegmentedTextPill/index.tsx`       | Mode selector  | keep with reason | The control is an explicitly labelled group of native buttons; each option exposes its selected state through `aria-pressed` and disabled options remain non-interactive. | —                |

## Summary

- 0 fixes required
- 13 kept with documented reason
- 0 abstraction candidates
