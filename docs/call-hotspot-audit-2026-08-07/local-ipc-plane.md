# Local Tauri IPC Plane (audit wave 2)

Scope: renderer→Rust invoke discipline app-wide, excluding the cloud planes and
member-runtime/usage surfaces covered in wave 1. Also resolves the cmd+5
`set_window_focus` hotspot question.

## set_window_focus: exonerated

Single mount (useWindowFocusTracking via AppDeferredServices), deduped per real
focus transition, Rust handler is a lock-read + flag flip. It leads traces only
because it is the FIRST IPC of every window switch. The real per-switch cost is
the fan-out behind it: sidebar aggregate-list refresh + PTY reconciliation +
CLI status reconcile + external-history scheduler wake + (Rust) git-status
polling accelerating to 3-5s × 4-6 processes. Future "window switch is slow"
work targets that list, not this command.

## Findings (top offenders; ~40 more setInterval hits are IPC-free UI clocks)

| #     | file:line                                                                                           | trigger                                    | cadence                                                                  | hidden gating                  | verdict                                                     |
| ----- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------- |
| 1     | MiniCpmCompactCard.tsx:47-51                                                                        | context-info popover open                  | raw setInterval 5s                                                       | **none** — keeps firing hidden | **VIOLATION** → fix: use startVisibilityAwarePoller         |
| 2     | launchpad useScriptDiscovery.ts:562-566 + useEnvScan.ts:213-223 + useRepoDetection.ts:139-141       | every window focus while launchpad mounted | none — 3 parallel FS-scan IPCs per focus, no coalescing/in-flight dedupe | n/a                            | **VIOLATION** → shared debounced focus handler              |
| 3     | useWebviewPositionSync.ts:64-69                                                                     | scroll with native webview overlay         | rAF-coalesced, delta-gated                                               | rAF pauses hidden              | WATCH (inherent overlay sync)                               |
| 4     | CliConfigSwitchCard.tsx:171                                                                         | AgentOrgs config page                      | 3s visibility-aware                                                      | ✓                              | WATCH (aggressive for a settings card)                      |
| 5     | externalHistoryAutoRefresh.ts:384-388                                                               | open imported session                      | 5s stat probe, 60s unfocused floor, size-tiered reload cooldown          | ✓                              | WATCH (well built; no event source exists)                  |
| 6     | sidebarSessionRefresh.ts:74-99                                                                      | interval + focus                           | 15s/60s, single-flight aggregate list                                    | ✓                              | OK (documented safety poll)                                 |
| 7     | agentOrgRunViewStore.ts:422-462                                                                     | WS push (50ms debounce) + 60s fallback     | visibility-gated                                                         | ✓                              | OK — model citizen                                          |
| 8     | useSessionPrStatuses.ts:131-137                                                                     | interval                                   | 5min TTL, ≤8 repos, 10min error backoff                                  | ✓                              | OK                                                          |
| 9     | useBranchPullRequestStatus.ts:184-204                                                               | CI pending                                 | exp 15s→60s, 3-attempt empty-CI cap                                      | ✓                              | OK                                                          |
| 10    | useTerminalProcessPoller.ts:142                                                                     | terminal activity signal                   | 350ms trailing                                                           | tree-visibility gated          | OK                                                          |
| 11    | terminalHandlers.ts:116-195                                                                         | keystroke/resize                           | microtask-batched / 50ms                                                 | n/a                            | OK                                                          |
| 12    | useBrowserConsole/NetworkLogs/APICallPanel                                                          | devtools panes open                        | 1s visibility-aware pollers                                              | ✓                              | WATCH (panes stack)                                         |
| 13    | useWebviewUrlPolling.ts:104-132                                                                     | visible inline webview                     | 1s single-flight                                                         | ✓                              | WATCH (no URL event from child webview)                     |
| 14-17 | RAM popover / Settings monitor / port scanner / OS-agent gateway                                    | surface open                               | 10-60s visibility-aware                                                  | ✓                              | OK                                                          |
| 18    | useBenchmarkRun.ts:163-185                                                                          | run RUNNING                                | 2s, stops at terminal                                                    | none                           | WATCH (deliberate background tracking, run-bounded)         |
| 19    | useWorkspaceGitStatus.ts:225-232                                                                    | WS singleton missing                       | 1s unbounded local retry (no IPC)                                        | no                             | WATCH (bound it)                                            |
| 20-25 | PTY reconcile / bg session monitor / quota grid / app updater / retryInvoke / projectSyncStatusAtom | event-driven                               | —                                                                        | ✓                              | OK (updater exemplary; sync status moved from poll to push) |

## Worst issues

1. MiniCpmCompactCard: the only recurring IPC with neither event source nor
   hidden gate — one-line fix.
2. Launchpad triple focus-scan: real disk-walking work multiplied by alt-tab
   rate; needs a shared debounced handler.
3. Window-switch fan-out (not set_window_focus itself) is the aggregate cost
   center for "app wakes up on focus" — inventory above, tune as a set.
