# Kanban → ChatPanel tab migration architecture audit

## Acceptance criteria

- The Workstation no longer mounts a dedicated Kanban station view or tab bar.
- Kanban is a singleton ChatPanel tab; Projects is an internal section of that tab.
- The active management tab is the source of truth for its title, rendered content, and app-sidebar selection.
- The active management tab also drives the outer Workstation sidebar highlight; no dedicated route or route-only station mode remains.
- Every tab pill resolves from its canonical tab type or linked entity; surface-header and globally active-session titles cannot override another tab's identity.
- Selecting a session in the Workstation sidebar focuses its existing session tab or creates and activates one; Launchpad cannot remain the active tab while session content opens.
- The Kanban tab defaults to full-screen ChatPanel presentation on entry and restores the user's prior maximize state on exit when the user has not explicitly restored the Workstation.
- The management tab keeps the top tab bar and maximize/Workstation toggle so full screen remains user-reversible, while suppressing the focused Workstation rail.
- Launchpad names the Work / Explore / Trend start page; Dashboard names the workspace summary surface and uses an Info icon.
- Every ChatPanel tab is closable; closing the final tab creates and activates the three-section Launchpad.
- Closing Kanban disposes its transient creator, preview, replay-event, playback, and header state while retaining persisted user preferences.
- The chat-tab storage key is versioned; stale management tabs are discarded instead of migrated.
- The app sidebar owns Kanban and Work Items navigation; List and Diary remain presentation modes in the 40px content header.
- Shortcut, Spotlight, action, Start Page, plus-menu, and sidebar entry points converge on one `openKanbanTab()` service path.
- Removed Workstation tab types/renderers have zero remaining references.
- Targeted ESLint, TypeScript, and tab-state tests pass.

## Ten-layer audit

| Layer                                 | Coverage                                                | Verdict          | Evidence / reason                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness            | TypeScript + changed-file lint                          | pass             | `pnpm exec tsc --noEmit --pretty false` and targeted ESLint complete with zero errors. Rust is untouched.                                                                                           |
| 2. Dead code / structural duplication | Old station path, duplicate identity, retained UI state | pass             | Deleted the retired management route, route-only station mode, peek/focus atoms, and Projects tab type; transient cleanup remains centralized in the canonical tab-close path.                      |
| 3. Naming consistency                 | Chat tab and service names                              | pass             | `start-page` is the Launchpad with Work / Explore / Trend; `dashboard` is the workspace summary; `work-management` owns both management sections under one visible tab identity.                    |
| 4. Semantic overloading               | `launchpad`, `dashboard`, `project`, `station`, `tab`   | pass             | Launchpad and Dashboard no longer label the same surface, surface-header context no longer doubles as tab identity, and Projects is explicitly an inner management section rather than another tab. |
| 5. Default branches                   | Tab activation, presentation, and empty-tab fallback    | pass             | Every tab variant explicitly synchronizes its surface state; management/terminal tabs use Session only as a neutral underlying surface. Final close explicitly activates Launchpad.                 |
| 6. Cross-domain leakage               | ChatPanel ↔ Kanban                                      | keep with reason | ChatPanel owns surface identity/presentation; Kanban continues to own its sidebar and management content. The shell lazy-load is an intentional host boundary, not duplicated domain logic.         |
| 7. New-developer clarity              | Entry points and ownership                              | pass             | `openKanbanChatPanelTabAtom`, `isChatPanelTabDefaultFullscreen`, and `openKanbanTab` distinguish entry defaults from enforced presentation.                                                         |
| 8. Wire protocol / serialization      | External payloads and local persistence                 | pass             | No backend protocol changed. The versioned ChatPanel storage key intentionally drops obsolete management-tab identities; terminal tabs remain excluded from persistence.                            |
| 9. Init parity                        | Shortcut, Spotlight, action, plus menu, sidebar         | pass             | All Kanban entry points converge on one tab atom; session rows focus linked tabs, while sidebar New Chat resets the draft and then creates and activates the localized Launchpad tab.               |
| 10. Resolver symmetry                 | Tab presentation and management selection               | pass             | Kanban and Projects follow the same activation chain; title, tab identity, content section, and outer sidebar highlight all resolve from the same active tab.                                       |

## Entry-point parity matrix

| Entry point                   | Opens singleton tab | Makes chat visible | Defaults full screen | Workstation restorable | Selects section |
| ----------------------------- | ------------------: | -----------------: | -------------------: | ---------------------: | --------------: |
| Shortcut / Action / Spotlight |                 yes |                yes |                  yes |                    yes |             yes |
| Start Page                    |                 yes |                yes |                  yes |                    yes |             yes |
| ChatPanel `+` menu            |                 yes |    already visible |                  yes |                    yes |             yes |
| App sidebar                   |                 yes |    already visible |                  yes |                    yes |             yes |

## Scoped-out layers

No Rust, database, session initialization, external wire protocol, queue lifecycle, or resolver logic changed. Those skill checklist areas were inspected for applicability and intentionally skipped beyond the explicit Layer 8–10 statements above.
