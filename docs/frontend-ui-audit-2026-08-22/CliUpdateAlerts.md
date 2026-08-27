# CLI update alerts UI audit

The documented `frontend-ui-audit` skill was unavailable at both the global and workspace paths. This manual fallback applies the repository's required design-system, spacing, and accessibility checks to the changed UI.

| Line                                  | Element                         | Verdict          | Reason                                                                                                                                                    | Suggested change |
| ------------------------------------- | ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionCreatorChatPanelView.tsx:294` | CLI version alert               | keep with reason | Reuses `InlineAlert`, the existing neutral alert surface, and a semantic upgrade icon. Copy stays on one line and all actions remain in the alert header. | None.            |
| `SessionCreatorChatPanelView.tsx:301` | Suppression and refresh actions | keep with reason | Reuses shared icon-only `Button` variants and sizes; both controls have localized tooltips and accessible labels.                                         | None.            |
| `CliUpdateAlertsSettingsRow.tsx:18`   | CLI update preference row       | keep with reason | Reuses `SectionContainer`, `SectionRow`, and `Switch`; the switch has a localized accessible label and stable test selector.                              | None.            |
| `AgentOrgsTableContent.tsx:62`        | CLI settings stack              | keep with reason | Uses the existing `gap-3` rhythm already established for this page and introduces no arbitrary layout values.                                             | None.            |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.
