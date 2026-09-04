# GitHub detail loading performance review

Scope: shared GitHub issue/PR skeletons, PR tab presentation, and the Inbox and
Source Control PR chunk-loading fallbacks. No loader, cache, transport, or
persistence implementation is changed.

| Area               | Verdict | Evidence                                                                                                                             | Change or reason kept                                                                   | Verification                                                                                                         |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Background work    | keep    | `PrDetailPanel` remains the owner of `useWorkstationPrDetail`; skeletons and shared tabs have no request, effect, timer, or listener | Existing loader retains request deduplication, stale-result checks, and unmount cleanup | 8 existing loader tests pass; source trace of chunk fallback through panel mount                                     |
| Memory             | keep    | Skeleton arrays and four tab descriptors are render-local; no new retained map, cache, or buffer                                     | Existing per-PR state owns navigation; React owns mounted tab subscriptions             | Loading/hydration/refresh tests pass; native RSS growth not measured                                                 |
| Scope/isolation    | keep    | Live tabs use the existing `workstationPrScopeKey(repoId, repoPath, number)` atom; chunk fallbacks consume identity props only       | No new auth/cache keys or data writers; unmount preserves existing view-state semantics | Existing loader tests pass; account/endpoint and secondary-instance checks not run because those paths are unchanged |
| Rendering/hot path | keep    | Four fixed tab descriptors and three/four sidebar sections; count placeholders use CSS pulse with reduced-motion support             | No JavaScript animation loop; labels stay real and only unknown values are placeholders | 44 focused DOM/SSR tests and 3 existing sidebar tests pass; native visible/hidden CPU not measured                   |

Lifecycle matrix:

| State                                   | Expected ownership/behavior                                                        | Evidence                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Lazy chunk loading                      | Static shared frame; no PR fetch or atom subscription in the fallback              | Source inspection of both Suspense hosts                                                  |
| Initial detail loading                  | Panel owns loading; its live tabs subscribe to the existing scoped atom            | Panel/header variants retain labels and navigation in DOM tests                           |
| Hydrated and cached refresh             | Real counts replace placeholders; cached refresh keeps counts and selected tab     | Focused DOM tests                                                                         |
| Offline/error                           | Existing loader error path and panel banner remain unchanged                       | Existing loader regression suite; no network test                                         |
| Unmount/reopen                          | React releases component subscriptions; existing loader cleanup retains view state | Source trace and loader regression suite; repeated native open/close not measured         |
| Visible/hidden/focus return             | No new JS polling; CSS animation scheduling is controlled by the webview           | Native idle/hidden CPU and focus-return measurements not run                              |
| Account/endpoint/scope/instance changes | Existing state and loader ownership are unchanged                                  | No new identity, transport, or persistence implementation; native topology checks not run |

Performance verdict: blocked for runtime measurement. Computer control was not
requested, so native visible-idle, hidden-idle, focus-return, repeated-open/close,
and post-close CPU/RSS checks were not run. Source review and automated checks
found no new background resource owner or unbounded retained collection; this
is not a measured performance-improvement claim. The verification gap is
explicitly disclosed in the pull request.
