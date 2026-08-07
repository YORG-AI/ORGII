# Launchpad Manage consolidation architecture audit

## Acceptance criteria

- Explore is renamed to Manage in all supported locales.
- The former workspace Dashboard renders only inside Launchpad Manage.
- No standalone Dashboard ChatPanel tab type, creator atom, icon branch, or plus-menu entry remains.
- Persisted Dashboard tabs migrate to Launchpad.
- Folders Dashboard navigation focuses Launchpad Manage without duplicating a Launchpad tab.
- Manage is lazy-loaded and unmounted when Work or Trends is selected.
- Work actions reuse the original rounded pill geometry; tones remain on containers and icons remain neutral.
- TypeScript, targeted ESLint, and focused state/UI tests pass.

## Ten-layer audit

| Layer                                 | Coverage                                | Verdict          | Evidence / reason                                                                                                                                        |
| ------------------------------------- | --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness            | TypeScript and changed-file lint        | pass             | `tsc --noEmit` and targeted ESLint complete successfully. Rust is untouched.                                                                             |
| 2. Dead code / structural duplication | Dashboard tab and render path           | pass             | Removed the `dashboard` ChatPanel tab variant, add-tab atom, icon/menu branches, display resolver case, and standalone `ChatPanelContent` render branch. |
| 3. Naming consistency                 | Start-page tabs                         | pass             | The canonical inner identities are now `work`, `manage`, and `heatmap`; user-facing labels are Work / Manage / Trends.                                   |
| 4. Semantic overloading               | Dashboard vs. Launchpad                 | pass             | Dashboard is retained only as a legacy navigation/migration term; workspace management UI has one live owner under Launchpad Manage.                     |
| 5. Default branches                   | Initial tab and legacy navigation       | pass             | Launchpad defaults to Work. Legacy Dashboard navigation redirects to Manage, and persisted Dashboard tabs normalize to `start-page`.                     |
| 6. Cross-domain leakage               | Launchpad ↔ workspace management        | keep with reason | `WorkspaceDashboardPanelView` remains a thin adapter over the shared launchpad module; ChatPanel owns only lazy hosting and inner-tab lifecycle.         |
| 7. New-developer clarity              | Open/focus actions                      | pass             | `openOrFocusChatPanelManageTabAtom` states its behavior and centralizes sidebar-to-Manage navigation.                                                    |
| 8. Wire protocol / serialization      | Local tab persistence                   | pass             | No external protocol changes. LocalStorage normalization explicitly maps old `dashboard` and `launchpad` tab identities to Launchpad.                    |
| 9. Init parity                        | Plus menu, new session, sidebar         | pass             | New session and Launchpad entry points reset to Work; Folders Dashboard focuses Manage; all paths use the same start-page state atom.                    |
| 10. Resolver symmetry                 | Tab title, sidebar selection, inner tab | pass             | Launchpad title resolution comes from `start-page`; folder Dashboard selection derives from `start-page + manage`; no Dashboard tab resolver remains.    |

## Lifecycle / memory boundary

`WorkspaceDashboardPanelView` is declared with `React.lazy` and rendered only by the `manageTabActive` conditional. React unmounts it when the active inner tab changes, releasing its repo, key-vault, agent-catalog, container, and container-engine subscriptions plus local selection state. The loaded JavaScript chunk remains browser-cached, as expected, but the heavy live component graph is not retained.

## Scoped-out layers

No Rust, database, external wire protocol, session launch protocol, or container backend behavior changed. Workspace detail and legacy Explore surfaces remain available through their existing sidebar paths.
