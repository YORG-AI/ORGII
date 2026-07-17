# Cloud org management tab architecture audit

Scope: the typed `cloud-org` chat tab, all production entry points that open it, activation/close behavior, and the managed-org switcher that updates its payload.

## Acceptance criteria

- Org management never borrows the Launchpad tab identity.
- At most one org-management chat tab exists.
- Switching organizations updates that tab in place.
- Switching away and back restores the selected organization.
- Leaving, deleting, or losing access to the selected organization closes the stale management tab.
- Sidebar management and post-create navigation use the same open/focus atom.
- TypeScript, focused unit tests, lint, and cloud i18n parity pass.

## Term overloading sweep

| Term               | Meaning in this change                                | Verdict                                                                             |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Launchpad          | The `start-page` tab hosting Work / Manage / Trend    | pass — no longer labels cloud organization management                               |
| Manage ORG         | The singleton managed-cloud organization settings tab | pass — one visible identity and one open/focus action                               |
| Manage             | Launchpad's workspace-management inner section        | keep with reason — separate from cloud-org settings and still owned by `start-page` |
| Organization / org | The selected managed-cloud organization payload       | pass — stored as `ChatPanelSelectedCloudOrg`, not inferred from a title             |

## Ten-layer audit

| Layer | Area inspected                       | Verdict        | Reason / evidence                                                                                                                                                                                 | Suggested change |
| ----: | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
|     1 | Compilation correctness              | pass           | `npm run typecheck`, focused ESLint, and 30 focused Vitest assertions pass.                                                                                                                       | None.            |
|     2 | Dead code and structural duplication | pass           | Sidebar manage, cloud-org creation, the in-page switcher, activation, and stale-org close all converge on the canonical chat-tab atoms; no parallel tab constructor remains.                      | None.            |
|     3 | Naming consistency                   | pass           | `cloud-org`, `openCloudOrgManagementInChatPanelTabAtom`, and `closeCloudOrgManagementChatPanelTabAtom` consistently describe tab identity and lifecycle.                                          | None.            |
|     4 | Semantic overloading                 | pass           | Launchpad remains only `start-page`; cloud settings render under a distinct `cloud-org` variant titled `Manage ORG`.                                                                              | None.            |
|     5 | Default branches                     | pass           | Tab display and activation explicitly handle `cloud-org`; no catch-all maps it to session, workspace, or Launchpad behavior.                                                                      | None.            |
|     6 | Cross-domain leakage                 | pass           | The generic tab store holds only a typed org identifier; cloud fetching and management remain in `Org2Cloud` / `CloudOrgPanelView`.                                                               | None.            |
|     7 | New-developer clarity                | pass           | The tab payload documents restoration semantics, and the open atom documents singleton switching behavior.                                                                                        | None.            |
|     8 | Wire protocol / serialization        | not applicable | No backend request, RPC payload, or external schema changed. The local tab store already starts fresh on app restart.                                                                             | None.            |
|     9 | Entry-point parity                   | pass           | Sidebar Manage ORG, post-create navigation, and the header org switcher all call `openCloudOrgManagementInChatPanelTabAtom`; leave/delete/roster loss use the matching close action.              | None.            |
|    10 | Resolver symmetry                    | pass           | The explicit `cloud-org` display branch resolves the localized Manage ORG label, while activation resolves the selected organization from the typed `cloudOrg` payload regardless of entry point. | None.            |

## Systematic sweep

- Searched every `CHAT_PANEL_SURFACE_KIND.CLOUD_ORG` production navigation site; no UI entry point bypasses the dedicated tab constructor.
- Searched every `ChatPanelTab` type/display/activation branch; the new variant has explicit title, icon, activation, singleton-normalization, and close handling.
- Existing rendered cloud-org specs were updated to click the visible General / Repo scopes / Members tabs before asserting or mutating their content.
