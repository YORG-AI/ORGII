# Workstation trail terminal controls performance review

| Area               | Verdict | Evidence                                                                           | Change or reason kept                                                                                                               | Verification                                                        |
| ------------------ | ------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Background work    | keep    | Corner listeners and one pending animation frame exist only during a terminal drag | Release, cancellation, blur, document hidden and unmount dispose resources; the fixed trail no longer installs a resize hook        | Rendered grip lifecycle tests                                       |
| Memory             | keep    | Fixed dimension state and at most three dock claims                                | Capacity is checked before session creation, including stale callbacks; no new cache, worker, observer or polling loop              | Repeated-drag cleanup, capacity and repeated-add tests              |
| Scope/isolation    | fix     | Existing sessions and claims remain authoritative in the current Jotai store       | My Station Open Tabs excludes pinned, chat-panel and agent-owned terminals in both wide and compact renderers                       | Production rail tests with real creation, claim and release writers |
| Rendering/hot path | keep    | Geometry is read at drag start; moves only record coordinates and queue one frame  | Live resizing avoids storage writes and skips unchanged sizes; release flushes final coordinates                                    | 60 moves coalesce into one frame/update; persistence tests          |
| Terminal ownership | keep    | Collapse changes geometry and visibility without dropping the mounted host         | Only the expanded body reserves extra column width; hide releases claims without killing; stop uses the existing termination writer | Dock integration and claim suites                                   |
| Font appearance    | keep    | Both initialization and live updates use the resolved host font size               | Pinned host uses 12px; other hosts retain the global setting; no global write or xterm recreation                                   | Two real component chains with mocked xterm/native setup            |
| Tooltip lifecycle  | keep    | Collapsed icons reuse ToolbarTooltip                                               | Existing hover delay and body portal are cleaned up on leave, expansion and unmount                                                 | Real collapsed tooltip integration and shared tooltip tests         |

## Authoritative boundaries

The terminal session pool contains valid sessions from several owners. Pinned
membership is authoritative in miniTerminalClaimedIdsAtom, written through
openMiniTerminalAtom and release/close actions. Open Tabs previously ignored
that membership and owner scope. Exclusion is the user's explicit My Station
product requirement, not a workaround for malformed data. Existing owner-ID
helpers exclude chat-panel and agent PTYs. Collapse retains claims; release/hide
returns eligible sessions to Open Tabs. No historical cleanup is required.

The creation invariant lives in openMiniTerminalAtom: reject a fourth claim
before invoking editorAddTerminalSessionAtom, but permit focusing an existing
claim at capacity. The dock forwards shell/profile/cwd options through this
writer instead of creating before claiming. Rejection leaves the session pool
unchanged. Claims are transient; no terminal content or persisted sessions are
migrated. Stop still reaches closeMiniTerminalSessionAtom, closeTerminalSessionAtom
and close_pty. Integration spies verify only the selected session is removed;
no OS process is launched or killed by these tests.

## Lifecycle matrix

- Start/visible idle: no drag listeners or animation-frame work
- Active drag: one pointer owner and at most one pending frame; foreign pointers ignored
- Hidden/blur/focus return: end the gesture and remove resources; return does not restart work
- Repeated open/drag: prior resources are removed before later interactions
- Collapse/unmount/shutdown: grip cleanup restores cursor/selection and cancels frames; a folded terminal retains its host
- Tab switching: at most three content-width tabs use native overflow; selection reveal reads only two rectangles and changes local scrollLeft, with no scroll listener or observer
- Instance scope: no auth, provider, network or sync changes; two numeric size preferences retain existing local UI scope

Only terminal dimensions persist, once at gesture/keyboard commit. The fixed
trail ignores old width/minimum preferences without deleting them. The two new
terminal keys are best-effort and clamped when loaded. Older builds ignore them;
clearing only these keys restores 400x260 defaults. Shared control sizing,
spacing, and stop presentation add no timers or subscriptions. The server
watcher's scanning and existing callbacks are unchanged.

## Verification

The isolated PR worktree was used, excluding unrelated Input/Textarea tests from
the shared checkout.

- Targeted Vitest run: **113 tests across 20 suites pass**, covering the production rail, terminal dock, resize gesture, dimension persistence, claim writer, font override, shared stop/tooltip primitives, responsive layout and project/PR consumers
- `pnpm run typecheck`: pass
- Scoped ESLint with `--max-warnings 0`: pass
- Scoped `pnpm exec prettier --check`: pass
- `pnpm run check:test-placement`: pass, 435 directories
- `git diff --check`: pass

Exact final verification commands are included in PR #1131's Verification
section. These are jsdom, source and compiler checks; xterm setup and termination
IPC are mocked. No native performance improvement is claimed.

Performance verdict: **blocked for native measurement**. Computer control was
not authorized, so native WebView/xterm fit, theme/viewport appearance, resizing
the native window mid-drag, visible/hidden idle CPU/RSS, active frame times and
post-close native behavior were not measured. Deterministic coalescing and
resource-cleanup tests pass; native matrix cells remain unverified. This
limitation is disclosed in the PR, which remains ready for review.
