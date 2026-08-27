# Session Creator repository chrome menu architecture audit

## Acceptance criteria

- Users can place the repository/branch/location chrome above or below the composer.
- Right-clicking that chrome opens a native OS menu instead of WebKit's browser menu.
- The menu offers only the applicable **Move to top** or **Move to bottom** command.
- The same menu offers **Show pinned actions** or **Hide pinned actions** for pinned skill, tool, built-in, and Canvas pills.
- An explicit position choice persists across app restarts and every Session Creator entry point.
- The pinned-action visibility choice persists across app restarts and is applied wherever its native menu is available.
- Hiding pinned actions preserves the pinned set and keeps the `…` management entry point available.
- Existing first-run behavior remains unchanged: Launchpad defaults above and standard layouts default below.
- Top and bottom presentations mirror the same outer and composer-seam padding.
- The native context menu is the only position control; no duplicate visible switch is rendered.
- Compact or hidden repository chrome does not expose an inapplicable position control.
- Bottom chrome renders outside the complete composer frame and disables the launchpad input glow to avoid flashing across the chrome seam.

## Ten-layer review

| Layer                      | Verdict        | Evidence                                                                                                                                                                                                                          |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation             | pass           | Full `tsc --noEmit`, focused ESLint, and focused menu, pinned-action, and persistence suites pass.                                                                                                                                |
| 2. Dead code / duplication | pass           | One native menu owns position and visibility commands. The coordinator reads two independent persisted preferences; the view projects them into chrome placement and pinned-pill presentation without duplicating the pinned set. |
| 3. Naming                  | pass           | `CreatorRepoChromePosition` names spatial state, while `creatorPinnedActionsVisibleAtom` and `showPinnedActions` name presentation state. `RepoChromeRow` owns their shared native menu only.                                     |
| 4. Semantic overloading    | pass           | Position (`top`/`bottom`) and pinned-action visibility (`boolean`) remain separate atoms. Visibility never means unpin, delete, disable, or hide unrelated setup controls.                                                        |
| 5. Default branches        | pass           | An unset position keeps layout-specific fallbacks; pinned actions default visible. Malformed position values normalize to `null`, while malformed visibility values normalize to visible.                                         |
| 6. Cross-domain leakage    | pass           | Session Creator owns the preference and effective compact/hidden fallback; shared `PinnedActionsBar` receives a presentation prop and does not import creator state.                                                              |
| 7. New-developer clarity   | pass           | Contextual menu keys read as commands (`moveToTop`, `moveToBottom`, `showPinnedActions`, `hidePinnedActions`), and the visibility atom documents that it preserves pins.                                                          |
| 8. Wire protocol           | not applicable | Both preferences are local UI storage only; no Tauri command schema, HTTP payload, database record, dependency, or lockfile changes.                                                                                              |
| 9. Init parity             | pass           | Launchpad, standard, compact, and hidden-repository variants enter through `SessionCreatorChatPanelContent`. The matrix records where position and visibility preferences are intentionally applicable.                           |
| 10. Resolver symmetry      | not applicable | Position has one explicit layout fallback; visibility has one safe visible fallback. No multi-field resolver or asymmetric fallback chain is introduced.                                                                          |

## Entry-point matrix

| Entry point                 | Unset position          | Explicit position          | Pinned-action visibility | Native menu |
| --------------------------- | ----------------------- | -------------------------- | ------------------------ | ----------- |
| Launchpad repository chrome | Above composer          | Honored                    | Honored                  | Available   |
| Standard repository chrome  | Below composer          | Honored                    | Honored                  | Available   |
| Compact embedded chrome     | Existing compact header | Not applied while embedded | Forced visible           | Unavailable |
| Hidden repository chrome    | Not rendered            | Not applied while hidden   | Forced visible           | Unavailable |

## Term table

| Term                     | Meaning                                                                                              | Owner                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------- |
| repository chrome        | Repository, branch, and running-location control strip around the Session Creator composer           | Session Creator view        |
| position preference      | Persisted explicit `top` or `bottom`; `null` means no choice has been made                           | Session store atom          |
| pinned-action visibility | Persisted presentation choice; it never mutates `pinnedActionsAtom`                                  | Session store atom          |
| layout fallback          | Existing first-run position selected from Launchpad versus standard layout                           | Session Creator coordinator |
| native context menu      | Tauri OS menu that suppresses the WebView menu and emits the applicable move and visibility commands | Repository chrome row       |
