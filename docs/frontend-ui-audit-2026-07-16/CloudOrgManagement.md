# Cloud org management — frontend UI audit

Scope: the cloud org management header, section tabs, organization switcher, and the chat-pane tab identity introduced for managed organization settings.

> The repository-referenced `frontend-ui-audit` skill was not installed at either documented path. This report follows the `AGENTS.md` report schema and systematic-sweep convention directly.

|                              Line | Element                                    | Verdict          | Reason                                                                                                                                                                                            | Suggested change |
| --------------------------------: | ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CloudOrgPanelView/index.tsx:534` | Pinned management header                   | keep with reason | Reuses the same `InternalHeader` and `DETAIL_PANEL_TOKENS` composition as Settings, so width, padding, and scroll separation remain design-system-owned.                                          | None.            |
| `CloudOrgPanelView/index.tsx:541` | Organization switcher                      | keep with reason | Uses the shared `Select` ghost variant with a pill radius. The fixed scale width prevents the selector from consuming the tab strip, while horizontal overflow protects narrow/localized layouts. | None.            |
| `CloudOrgPanelView/index.tsx:553` | General / Repo scopes / Members navigation | keep with reason | Uses the shared `TabPill` simple/large variant from Settings, with native button semantics and stable test IDs supplied by the component.                                                         | None.            |
| `CloudOrgPanelView/index.tsx:576` | Section visibility                         | keep with reason | Each management domain has one visible owner and preserves its existing `SectionContainer` / `SectionRow` composition; no duplicate visual pattern was introduced.                                | None.            |
|         `ChatPanelTabBar.tsx:169` | Manage ORG chat-tab icon                   | keep with reason | `Settings2` matches the existing sidebar manage action and clearly distinguishes org settings from the Launchpad grid icon.                                                                       | None.            |

## Sweep summary

- Fix: 0
- Keep with reason: 5
- Abstract: 0
- Design-system sweep: no new raw controls, arbitrary colors, duplicated pill implementations, or missing interactive labels found in the changed UI.
