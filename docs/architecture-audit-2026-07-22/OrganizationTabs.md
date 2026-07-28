# Organization tabs — architecture audit

## Acceptance criteria

- Every Chat Panel cloud/local organization entry point opens one fixed organization tab instead of separate `cloud-org` and `project-org` tab types.
- The tab payload is a discriminated cloud/local union; activation restores the matching legacy navigation mirror for integrations that still observe it.
- Switching the organization picker updates the existing tab in place and never stacks another organization tab.
- Persisted legacy cloud/local organization tabs migrate into one shared tab, preferring the previously active organization.
- Sidebar Manage ORG remains enabled for a selected or fallback local organization as well as a cloud organization; personal-only state falls back to Add ORG.
- Cloud aliases do not appear as duplicate local organizations; personal scope appears once in the picker but is excluded from local-management fallback selection.
- Cloud and local surfaces render through the same organization renderer and shared pinned-header contract.
- TypeScript, targeted ESLint, focused Vitest, formatting, and whitespace validation pass.

## Ten-layer audit

| Layer | Coverage                           | Verdict | Evidence / reason                                                                                                                                                                                                          |
| ----: | ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Compilation correctness            | pass    | Full `tsc --noEmit`, targeted ESLint, and 54 focused Vitest assertions pass.                                                                                                                                               |
|     2 | Dead code / structural duplication | pass    | The two Chat Panel tab types, factories, openers, renderers, and cloud-only target selector were replaced by one organization path. The remaining Workstation `project-org` type belongs to its separate main-pane router. |
|     3 | Naming consistency                 | pass    | `organization` names the shared tab; `cloud` and `local` are explicit payload variants. Provider-specific panels retain their existing domain names.                                                                       |
|     4 | Semantic overloading               | pass    | `ChatPanelSelectedOrganization` is a discriminated union, so a tab cannot carry cloud and local payloads simultaneously.                                                                                                   |
|     5 | Default branches                   | pass    | Activation and rendering branch explicitly on `organization.kind`; no catch-all silently reinterprets an unknown provider.                                                                                                 |
|     6 | Cross-domain leakage               | pass    | The shared tab/router owns provider selection only. Cloud mutations remain in `CloudOrgPanelView`; local project/work-item behavior remains in `ProjectOrgPanelView`.                                                      |
|     7 | New-developer clarity              | pass    | One fixed ID, one factory, one opener, one surface renderer, and one picker-entry builder define the complete path.                                                                                                        |
|     8 | Wire protocol / serialization      | pass    | No backend contract changed. The local-only compatibility boundary migrates persisted `cloud-org` / `project-org` records to the current union.                                                                            |
|     9 | Entry-point parity                 | pass    | Sidebar Manage, Projects local-org rows, cloud creation, and the in-panel picker all call `openOrganizationInChatPanelTabAtom`.                                                                                            |
|    10 | Resolver symmetry                  | pass    | Cloud and local activation replay their matching legacy surface command; both render from the same canonical tab payload and fixed identity.                                                                               |

## Call path

`organization entry point` → `openOrganizationInChatPanelTabAtom` → create or update fixed `chat-organization-management` tab → `OrganizationSurfaceRenderer` branches on `kind` → provider panel renders inside the shared pinned organization header.

## Entry-point parity matrix

| Entry point                | Cloud target                                  | Local target                                  | Tab behavior                                                         |
| -------------------------- | --------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Sidebar Manage ORG         | Selected cloud org, then first cloud fallback | Selected local org, then first local fallback | Updates/focuses the singleton organization tab; local opens Settings |
| Projects organization row  | Not applicable                                | Selected project org                          | Updates/focuses the singleton organization tab; opens the org hub    |
| Cloud org creation         | Newly created cloud org                       | Not applicable                                | Updates/focuses the singleton organization tab                       |
| Pinned organization picker | Any live cloud roster org                     | Personal scope or any non-alias local org     | Retargets the same tab in place                                      |
| Persisted legacy state     | Migrates `cloud-org`                          | Migrates `project-org`                        | Collapses to one tab, preferring the active legacy target            |

## Scoped-out layers

No backend API, database schema, cloud authentication flow, project mutation contract, Workstation main-pane tab type, or organization membership policy changed.
