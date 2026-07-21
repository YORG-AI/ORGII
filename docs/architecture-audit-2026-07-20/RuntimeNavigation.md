# Architecture Audit — Runtime Navigation

**Scope:** promoting Runtime from a Launchpad subview to a singleton chat-panel tab, adding its sidebar entry, and composing Usage / Scanning / Hooks / Assets beneath the shared chat header.

## Acceptance criteria

- [x] Runtime is a first-class, persisted `ChatPanelTabType` with an exhaustive renderer entry.
- [x] The sidebar opens and selects the singleton Runtime tab directly below Work Items.
- [x] Runtime uses the shared chat header, including its tab strip and My Station maximize/restore control.
- [x] Usage / Scanning / Hooks / Assets remain a separate in-content navigation row, with Usage first and Assets last.
- [x] Quota renders in Usage; the former Manage dashboard renders in Assets.
- [x] Launchpad contains only the Work launcher content.
- [x] Focused tests, ESLint, TypeScript typecheck, and whitespace validation pass.

## 10-layer review

| Layer | Coverage                             | Verdict          | Notes                                                                                                                                                                                                                |
| ----: | ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Compilation correctness              | pass             | The focused 44-test suite, changed-file ESLint, `pnpm typecheck`, and `git diff --check` pass.                                                                                                                       |
|     2 | Dead code / structural deduplication | pass             | The old Launchpad `manage` / `runtime` subview state, Manage opener, and workspace-dashboard navigation command were removed. Runtime has one factory, one singleton opener, and one renderer registration.          |
|     3 | Naming consistency                   | pass             | `runtime` is used consistently as the tab discriminant and sidebar ID; `chat-runtime` is its stable singleton tab ID; Assets names the former dashboard content.                                                     |
|     4 | Semantic overloading                 | keep with reason | `runtime` denotes the user-facing operational surface only inside chat-tab/navigation domains. Scanning, Hooks, Usage, and Assets remain distinct inner-view names rather than additional meanings of the outer tab. |
|     5 | Default branches                     | pass             | The display-title switch and renderer registry handle Runtime explicitly; the registry remains exhaustive through `Record<ChatPanelTabType, ...>`. Persisted Runtime duplicates normalize to one tab.                |
|     6 | Cross-domain leakage                 | pass             | The ChatPanel engine owns Runtime composition. The shared data-source panel receives optional Usage/Assets content and remains reusable by Kanban without importing ChatPanel components.                            |
|     7 | New-developer clarity                | pass             | `RuntimePanelView` is the single composition point, inner tabs are visibly declared in required order, and comments distinguish the outer chat tab from its inner views.                                             |
|     8 | Wire protocol / serialization        | not applicable   | No request, response, IPC, event, or backend payload changed. Persisted chat-tab normalization only adds singleton handling for the new local UI discriminant.                                                       |
|     9 | Init parity                          | pass             | Sidebar opening, persisted hydration, and header-pill activation all flow through the same tab factory/activation/presentation chain. Runtime preserves the normal docked presentation from every entry point.       |
|    10 | Resolver symmetry                    | not applicable   | No multi-source fallback resolver or field-priority chain changed.                                                                                                                                                   |

## Entry-point parity matrix

| Entry point                  | Creates duplicates   | Activates Runtime | Preserves other tabs / layout | Uses shared header |
| ---------------------------- | -------------------- | ----------------- | ----------------------------- | ------------------ |
| Sidebar Runtime item         | No; singleton opener | Yes               | Yes                           | Yes                |
| Existing Runtime header pill | No; existing tab     | Yes               | Yes                           | Yes                |
| Persisted Runtime tab        | Duplicates collapsed | Yes               | Yes                           | Yes                |

## Systematic sweeps

- Legacy Launchpad subview symbols (`ChatPanelStartPageTab`, `openOrFocusChatPanelManageTabAtom`, `WORKSPACE_DASHBOARD`) have zero remaining source hits.
- All `work-management` special cases were inspected for Runtime parity. Runtime was added only where behavior is shared (non-session activation and shared-header suppression rules) and intentionally omitted from management-only fullscreen/state cleanup.
- `ChatPanelTabType` display and renderer discriminants remain exhaustive; unknown persisted types still resolve to the existing explicit placeholder.

No Rust, backend, wire-schema, or multi-field resolver layer changed.
