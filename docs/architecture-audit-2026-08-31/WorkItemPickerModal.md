# WorkItemPickerModal architecture review

Acceptance: one reusable selector serves every attachment presentation without expanding the composer; existing data projection, selection payloads, source bounds, and cancellation semantics remain intact.

| Layer                  | Coverage and conclusion                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Compilation        | The isolated stack reruns full TypeScript and targeted tests; exact commands and outcomes are recorded in the PR Verification section                                                         |
| 2 — Structure          | The modal owns loading and transient selection; the consumer owns insertion. Variant-local panel/model copies and the composer portal/state are removed                                       |
| 3 — Naming             | Modal open/onClose/onSelect props describe selection, not composer expansion; obsolete portal and expanded-state props are removed                                                            |
| 4 — Semantics          | Selection is committed only by Add; close/cancel leaves the draft intact. The redundant top-row Add work item button is removed while Solve Work Item remains                                 |
| 5 — Defaults           | Each open starts with an empty query/selection and All sources. The optional Modal focus ref defaults to the existing primary/first enabled control behavior                                  |
| 6 — Boundaries         | Shared Modal owns keyboard/focus/dismissal; WorkItemPickerModal has no ComposerInputRef and cannot mutate drafts                                                                              |
| 7 — Readability        | One public selector replaces anchored/expanded branches; leaf panel and data projection stay private to the selector folder                                                                   |
| 8 — Serialization      | Workspace/provider APIs, pill paths, linked-item context and persisted formats are unchanged; no migration or historical cleanup is required                                                  |
| 9 — Entry-point parity | Card, pill and button/link presentations share the same tested selector and insertion callback; the later layout layer chooses the card/pill presentation                                     |
| 10 — Resolver symmetry | One option projection/filter/selection owner serves both sources. Repo identity remounts state, local generations reject late responses, and the existing GitHub cache remains the sole owner |

All ten layers were considered. Rust, transport, session initialization, and provider ingestion are unchanged and require no new backend/wire validation. The relocated model is byte-identical to its previous implementation. Forty-nine tests in eight suites cover selection, duplicate insertion, domain payloads, focus, cancellation, close/reopen, repository switching, stale completion, cache bounds, and existing launchpad behavior. Native desktop geometry and performance are not inferred from these tests.

Rollback is a code revert; no data repair is needed. The shared Modal prop is optional and its focus timeout is canceled on cleanup.
