# ImportCookiesModal UI audit

| Line | Element | Verdict | Reason | Suggested change |
| ---- | ------- | ------- | ------ | ---------------- |
| `src/modules/WorkStation/Browser/ImportCookies/ImportCookiesModal.tsx:457` | Modal back navigation | keep with reason | Uses the shared `Modal.onBack` seam, which delegates to `PanelHeader` and keeps the back control before the title. | None. |
| `src/scaffold/ModalSystem/index.tsx:414` | Modal header back slot | keep with reason | Reuses `PanelHeader.onBack` and `PANEL_HEADER_TOKENS.actionButton`, so the back button shares the close button's design-system treatment. | None. |
| `src/modules/WorkStation/Browser/ImportCookies/ImportCookiesModal.tsx:315` | Preview site search | keep with reason | Reuses the shared `SearchInput` with its standard sidebar variant, clear action, focus treatment, and accessible label. | None. |
| `src/modules/WorkStation/Browser/ImportCookies/ImportCookiesModal.tsx:121` | Browser source row | keep with reason | A full-width interactive row needs a custom hit area and layout that the compact `Button` API does not express without fragmenting the row structure. | None. |
| `src/modules/WorkStation/Browser/ImportCookies/ImportCookiesModal.tsx:131` | Browser icon sizing | keep with reason | The 18px size is a deliberate match for the source-row icon slot and is paired with explicit intrinsic dimensions to prevent layout shift. | None. |

Verdict totals: **0 fix**, **5 keep with reason**, **0 abstract**.
