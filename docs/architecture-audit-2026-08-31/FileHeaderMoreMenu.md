# FileHeaderMoreMenu architecture review

Acceptance criteria: file actions remain on the first level; editor display controls and More settings move into a submenu; session/editor submenus share one implementation; both labels use `Layers01Icon` and one common translation key; settings callbacks and persistence are unchanged; no old component or translation-key references remain.

| Layer                         | Coverage and result                                                                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Compilation               | Scoped ESLint and full TypeScript check pass on the isolated PR branch based on the latest `origin/develop`.                                                                                                               |
| 2 — Dead code and duplication | Moved the existing session surface into `components/Dropdown/ActionMenuSurface.tsx`; both production callers import it directly. Removed the old file without a compatibility re-export.                                   |
| 3 — Naming                    | Shared exports and DOM attributes no longer carry a session prefix. All source references were updated, including existing interaction tests.                                                                              |
| 4 — Semantic overloading      | `ActionMenuSurface` owns a menu tree; `ActionSubmenu` owns a left-opening flyout; `common:actions.uiSettings` names the shared display-settings entry. None represents persisted settings state.                           |
| 5 — Defaults                  | Existing action eligibility, checked values, and callbacks are preserved. Engine keyboard/Escape defaults are explicitly disabled because the shared surface owns navigation and one-layer dismissal.                      |
| 6 — Domain boundaries         | Shared menu code imports React, dropdown primitives/tokens, and icons only. Editor code does not import the chat engine. The label moves from sessions to common in all 13 locales.                                        |
| 7 — Readability               | The file header documents its three groups; the shared submenu documents its left-opening behavior.                                                                                                                        |
| 8 — Wire protocol             | Intentionally skipped: no API, IPC, serialization, schema, or persistence changes.                                                                                                                                         |
| 9 — Initialization parity     | Both entry points mount the same surface while their menu is open. The editor uses the existing dropdown engine for positioning/outside-click/overlay ownership. Tests exercise the real shared surface and editor engine. |
| 10 — Resolver symmetry        | Intentionally skipped: no resolver or fallback-chain changes.                                                                                                                                                              |

Call path: existing file/diff views → shared `FileHeader` → `FileHeaderMoreMenu` → existing toggle/action callbacks. The parent continues to own saved settings and close-on-action behavior. Session callers keep their existing menu engine and action handlers.

An exact source comparison after normalizing names, the context-error text, and the added doc comment confirmed that the extracted flyout preserves the previous session implementation. A source sweep found no remaining old component names, session-scoped UI-settings key, or old flyout DOM attribute.

No backend validation was needed. No dependencies, settings formats, or persisted data changed. Rollback is a source revert; no data remediation is required.
