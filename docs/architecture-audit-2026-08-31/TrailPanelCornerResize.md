# Workstation trail terminal controls architecture review

Acceptance criteria: resize only the expanded terminal from its bottom-left
corner; keep Workstation Trail fixed; show one terminal name or a chevron plus at most three terminal
tabs on one horizontally scrollable row, with no generic expanded title or overflow menu; use shared red stop controls for actual process
termination; fold to a centered process count and trail width; preserve pinned
terminal exclusion and one-owner PTY mounting; save dimensions only on commit.

| Layer                     | Coverage and result                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Compilation             | Isolated PR worktree passes full TypeScript checking, scoped lint, and 113 tests across 20 suites                                                                        |
| 2 Ownership/deduplication | Local dimension hook owns only terminal preferences; one stop primitive serves all requested termination surfaces; existing terminal atoms remain authoritative          |
| 3 Naming                  | Panel dimensions are CSS pixels, separate from the column's 8px inset; stop actions remain distinct from closing views                                                   |
| 4 Semantic distinctions   | Docked terminal stays in flow; hiding releases claims without killing; read-only main view closes without killing; process count counts claimed terminal sessions        |
| 5 Defaults                | Trail is fixed at the shipped size; terminal defaults to 400x260 and clamps restored sizes to width 320–720 / height 120–720                                             |
| 6 Boundaries              | Shared claim writer now guards capacity before creation; the optional creation-options argument is backward compatible; no new backend paths                             |
| 7 Readability             | Header presentation, grip lifecycle, dimensions, and persistence are separated; obsolete trail size state/menu/helpers are removed                                       |
| 8 Wire protocol           | Not applicable: no API, IPC signature, database, or network serialization changes                                                                                        |
| 9 Entry parity            | Pointer and keyboard resize share calculations and commit callbacks; click and keyboard tab selection use the same atom; all dock creation uses the guarded claim writer |
| 10 Resolver symmetry      | New numeric terminal preferences use best-effort reads and clamping; collapsed geometry ignores expanded size without discarding it                                      |

Only two new numeric localStorage preferences remain:
`orgii:workstationTrailTerminalWidth` and
`orgii:workstationTrailTerminalHeight`. Older trail width/minimum/height keys are
ignored, not destructively removed. Older builds ignore the new keys; clearing
only the two terminal keys restores 400x260 defaults. No user content is migrated.

The Open Tabs exclusion is an explicit product requirement for valid pinned
terminals. Authoritative sessions remain in `terminalSessionsAtom`, claims in
`miniTerminalClaimedIdsAtom`. `openMiniTerminalAtom` now checks the shared limit
of three before creation or admission; already claimed terminals can still be
focused at capacity. The panel now forwards optional shell/profile/cwd settings
through that atom instead of creating before claiming. This closes both the
UI and programmatic paths, including repeated stale add callbacks. Tests verify
that rejection does not add sessions and existing unclaimed Workstation
terminals are untouched. Claims are transient and not persisted; no stored
terminal cleanup or migration is needed. Stopping still reaches
`closeMiniTerminalSessionAtom` → `closeTerminalSessionAtom` → `close_pty`; the
integration test spies on that IPC boundary and verifies only the selected
session is removed. The same test proves hide preserves all sessions.

No terminal output subscription, PTY owner, process-management protocol, or
background scan changed. Agent sidebar stop still uses its existing actual kill
callback; the main read-only agent view retains its existing close-only behavior.

Unverified: native WebView geometry, theme appearance, actual xterm fit, and a
native window resize midway through a drag. Very short windows retain the capped
flex-column behavior, which can constrain actual visible panel height.

Horizontal scrolling uses browser overflow. Selected-tab reveal reads two rectangles only when active selection or folded state changes, compensates for CSS scaling, and writes only the strip’s scrollLeft; no observer, global scroll, timer or scroll listener is added.

Header geometry follow-up: shared trail controls now consume the existing
BUTTON_SIZE.sm (20px) token. Header and section right padding is 3px, compensating
for the former 26px control, while the containing row is 24px tall. The tab-bar
action-cluster token owns 1px button gaps; callers pass fragments. An absent title creates no
empty padded span. In single-terminal mode the plain name owns the same label ID
that the selected tab owns in multi-terminal mode, preserving the content’s
aria-labelledby relationship. No state, persistence, IPC or backend changes are
introduced by this styling/presentation follow-up.

Font follow-up (layers 2–7, 9–10): the pinned host passes 12px through an optional
`fontSize` prop on TerminalCore and TerminalView. TerminalView resolves the prop
against the existing global setting once per render; both the initial appearance
snapshot and live appearance effect consume that same resolved value. Shared
terminal code has no pinned-host branch or fixed compact font default. Other
hosts omit the prop and keep their existing behavior. Removing an override returns
to the current setting, and changing it does not affect the xterm mount effect's
dependencies. The integration test exercises two real component chains with
mocked xterm/native setup, checking initial size, live setting changes, override
changes/removal, refit, and no terminal recreation. Layer 1 passes in the isolated
PR worktree; layer 8 still has no wire or persisted format changes.

Collapsed icons reuse ToolbarTooltip with the existing item shortcut metadata.
No shortcut bindings change. The collapsed renderer previously dropped that
metadata in favor of native titles. Tests check keycaps, portal cleanup on hover
exit and expansion, and cancellation of a pending tooltip when its trigger unmounts.
