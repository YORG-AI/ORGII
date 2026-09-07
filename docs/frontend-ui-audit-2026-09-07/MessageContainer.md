# MessageContainer UI audit

| Line                                              | Element            | Verdict          | Reason                                                                                                   | Suggested change |
| ------------------------------------------------- | ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/components/Message/MessageContainer.tsx:26`  | Type border colors | keep with reason | Shared notification primitive uses semantic theme tokens to retain message tone without decorative icons | None             |
| `src/components/Message/MessageContainer.tsx:128` | Toast shell        | keep with reason | Existing responsive sizing and shadows belong to the shared primitive; icon removal leaves no spacer     | None             |
| `src/components/Message/MessageContainer.tsx:184` | Dismiss button     | keep with reason | Functional close control retains its localized accessible label; it is not a leading status icon         | None             |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.

Reviewed raw HTML, tokens, sizes/colors, accessibility and duplication. No lifecycle changes. Auto-dismiss and action code is unchanged; tests cover lazy rendering, teardown and icon omission. Desktop visual verification was not performed because computer control was not authorized.

## Localization findings

Refresh summary formatting already calls translation keys; missing catalog entries caused English fallback. Added three refresh outcomes across all supported locales, with a colon separator, and filled two missing task-notification messages. No persisted data is involved or requires remediation.

A source scan also found hardcoded messages outside the catalog gaps fixed here:

- `src/engines/ChatPanel/hooks/useInputArea/usePromptPolish.ts:135`: five Chinese prompt-polishing notices, including a formatted error
- `src/modules/shared/DevTools/ComponentIssueModal/index.tsx:51`: six English copy/payload notices, including dynamic labels
- `src/engines/ChatPanel/ChatHistory/renderers/GroupItemRenderer.tsx:441`: “Workspace is working!”
- `src/modules/WorkStation/CodeEditor/hooks/useCodeEditorEvents.ts:312`: unavailable terminal session
- `src/modules/WorkStation/CodeEditor/hooks/useCodeEditorHandlers.ts:350`: timeline diff failure
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/CodeViewerContent/views/PlanFileActions.tsx:52`: empty plan file

These remain follow-up localization work; this is a scan of direct Message calls and missing toast catalog keys, not a claim that every application string is localized. Backend-supplied warning text in sessionHandlers also needs its own error-code/localization boundary review.

## Verification

- `pnpm exec vitest run --config config/vitest.config.ts src/components/Message/__tests__`: 19 tests passed (13 locale catalog checks and 6 renderer tests). Existing missing-i18next-instance warning appears in the renderer fixture.
- `pnpm exec eslint src/components/Message/MessageContainer.tsx src/components/Message/__tests__/notificationTranslations.test.ts src/components/Message/__tests__/messageLazyContainer.test.ts`: passed.
- `node scripts/quality/check-missing-i18n-keys.mjs --namespace integrations --prefix keyVault.toasts`: zero missing keys.
- `git diff --check`: passed.
- Full application/runtime and visual checks were not run. Translations have not had native-speaker review.
