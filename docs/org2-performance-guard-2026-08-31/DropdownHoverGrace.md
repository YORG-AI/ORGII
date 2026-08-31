# Dropdown hover grace performance guard

| Area               | Verdict | Evidence                                                                                                                                   | Change or reason kept                                                                                                                                   | Verification                                                                                                                                                            |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background work    | fix     | Dropdown/WorkItemContextMenu could replace a timeout handle without first clearing the old timer; ActionMenuSurface dismissed immediately. | One replaceable 350 ms timeout; cancel before rescheduling and before explicit activation. Visibility listener exists only during that pending timeout. | Hook tests assert at most one timer, listener removal, and no stale transition after cancel/close/hide/unmount. Component regressions exercise repeated leave/re-entry. |
| Memory             | keep    | Only a timeout handle, one listener cleanup, and its pending transition closure are retained per active owner.                             | No app-global cache, list, scan, interval, or pointermove listener introduced.                                                                          | Twenty open/close cycles return timer count to zero every time; listener removal is asserted.                                                                           |
| Scope/isolation    | keep    | All state belongs to a mounted menu tree; no org/session/identity keys or backend state.                                                   | No cross-instance or cross-account resources. Closed/disabled/hidden owners do not schedule work.                                                       | Disabled/hidden/closed/unmounted cases covered in hook and controlled Dropdown tests.                                                                                   |
| Rendering/hot path | keep    | Existing enter/leave events request a transition; actual state writes happen on opening or on an intentional settled transition.           | No continuous pointer tracking, polling, extra positioning loop, or React state per mousemove. Existing layout and keyboard owners remain intact.       | Actual menu DOM tests pass for third-option selection, adjacent rows, nested portals, and immediate keyboard/click activation. CPU/RSS were not measured.               |

## Lifecycle matrix

| State                                                          | Expected and observed                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Mounted and idle / no submenu open                             | No hover timer or visibility listener; unit-tested.                                                               |
| Pointer leaves / crosses sibling                               | At most one pending transition; re-schedule replaces the old transition; unit-tested.                             |
| Pointer returns to trigger / enters child panel                | Pending transition canceled; panel remains open beyond its former deadline; tested in the three real menu owners. |
| Intentional leave / hover a different row                      | Transition runs once after grace; timer and listener are released; tested.                                        |
| Hidden / focus return                                          | Pending work is discarded immediately and is not replayed on return; unit-tested.                                 |
| Controlled close / disabled / unmount                          | Pending work is removed; no late visibility callback; unit-tested.                                                |
| Repeated open/close                                            | Twenty cycles retain no timer; unit-tested.                                                                       |
| Network, provider, transport, org, session, secondary instance | Not applicable: local transient pointer state only, no transport or shared resource changes.                      |
| Real visible/hidden Tauri CPU/RSS and physical pointer motion  | Not run. Desktop UI control is explicit opt-in and was not requested.                                             |

## Verification

- Targeted Vitest command recorded in `docs/architecture-audit-2026-08-31/DropdownHoverGrace.md`: 59 passing tests, 26 added for this change.
- Exact changed-file ESLint command in that report passes; `git diff --check` passes.
- Full `pnpm run typecheck --incremental --tsBuildInfoFile .git/.tsbuildinfo` passes in the clean PR checkout. Unrelated Input/Textarea work from the original workspace is not included.
- No runtime performance improvement is inferred from typecheck or source shape. Deterministic resource-lifecycle assertions passed; native pointer/CPU/RSS verification remains absent.

Performance verdict: blocked — automated lifecycle invariants and compilation pass, but real Tauri pointer/CPU/RSS verification was not run. This is a verification limitation, not a request to change desktop-control permissions.
