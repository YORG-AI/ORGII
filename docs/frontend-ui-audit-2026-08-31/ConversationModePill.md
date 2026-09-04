# ConversationModePill UI audit

| Line                                                                     | Element                                        | Verdict          | Reason                                                                                                                                                                                       | Suggested change                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/features/Org2Cloud/SessionConversation/ConversationModePill.tsx:30` | Agent / Team chat switch                       | fix              | Both destinations need to remain discoverable without crowding the docked composer. The user's requested GUI / TUI pill already supplies the shared surface.                                 | Applied: use `SegmentedTextPill`, showing `Infinity01Icon` / `MessagesSquareIcon` in every pane size, including maximized. |
| `src/features/Org2Cloud/SessionConversation/ConversationModePill.tsx:49` | Explanatory tooltips (also line 69)            | fix              | Icon choices need the existing destination explanations, using the app's shortcut-tooltip presentation rather than native title hints. No keyboard shortcut is registered for these choices. | Applied: `KeyboardShortcutTooltipContent` with `noShortcut`, attached to each complete segment button by the shared pill.  |
| `src/features/Org2Cloud/SessionConversation/ConversationModePill.tsx:38` | Accessible labels and selection (also line 58) | keep with reason | Localized button names remain available when visible text is replaced by decorative icons. Native buttons and `aria-pressed` preserve keyboard activation and selection semantics.           | None.                                                                                                                      |
| `src/features/Org2Cloud/SessionConversation/ConversationModePill.tsx:43` | Size and theme                                 | keep with reason | Icons use `PILL_SM_ICON_SIZE`; surfaces, text colors, height, and padding remain owned by the shared pill. No custom colors or new fixed widths are introduced.                              | None.                                                                                                                      |

Verdict totals: **2 fix**, **2 keep with reason**, **0 abstract**.

The visibility guard, per-session mode atom, and submit routing are unchanged.
The switch is icon-only in every pane size and no longer subscribes to the
maximize preference. It does not resize the pane or change the selected mode.
There is no new keyboard binding or translation key.

Verification:

- `pnpm exec vitest run src/features/Org2Cloud/SessionConversation/ConversationModePill.test.ts src/components/SegmentedTextPill/SegmentedTextPill.test.ts src/components/Tooltip/index.test.ts src/components/KeyboardShortcut/index.test.ts` — passed, 23 tests. Includes real component rendering, both glyphs, accessible labels, maximize/restore, session isolation, selection, tooltip text/dismissal, availability guards, and three open/unmount cycles.
- `pnpm exec eslint src/components/SegmentedTextPill/index.tsx src/features/Org2Cloud/SessionConversation/ConversationModePill.tsx src/features/Org2Cloud/SessionConversation/ConversationModePill.test.ts src/icons.ts --max-warnings 0 --report-unused-disable-directives` — passed.
- `pnpm run check:test-placement` — passed.
- `pnpm run typecheck` — passed in the isolated PR checkout based on the latest `develop`.
- Desktop screenshots, theme appearance, and narrow localized layouts were not visually verified: Computer Use was not requested. DOM tests do not establish pixel-level appearance.

The shared-component review is in `SegmentedTextPill.md`; lifecycle evidence and
remaining performance verification limits are in
`../org2-performance-guard-2026-08-31/ConversationModePill.md`.

Icon-only follow-up: the same 23 focused tests were rerun, including the updated
maximize/restore assertion. Targeted lint and formatting cover
`ConversationModePill.tsx` and `ConversationModePill.test.ts`; the shared primitive
is unchanged. Full typecheck was rerun and passed in the clean PR checkout.
Desktop measurements were not run because Computer Use was not requested.
