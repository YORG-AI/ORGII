# Claude provider profiles performance guard

| Area               | Verdict | Evidence                                                                                             | Change or reason kept                                                                   | Verification                                                                             |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Background work    | keep    | Only user actions start discovery/tests; existing status invalidation is mount/focus/mutation driven | No new polling/timers; only selected app editor mounts                                  | DOM tests cover test cancellation at unmount and ignore late completion                  |
| Memory             | keep    | Catalog cap 64/app; discovery max 1,000 IDs/256 KiB; shared request cap 4, receipt cap 64/15 min     | Discovery results stay local to mounted editor; endpoint/key/auth changes discard them  | Rust catalog/response validation and receipt tests                                       |
| Scope/isolation    | keep    | Native app target, complete profile/revision, endpoint, auth and credential bind activation          | Revision checks and existing target locks/transactions prevent stale native writes      | Isolated native save/apply/restore and stale-profile tests; cross-target rejection tests |
| Rendering/hot path | keep    | Maximum five mapping rows; local draft edits; no session/stream subscriptions                        | Single-flight status hook is reused; request generation changes at edits/cancel/unmount | Rendered form tests and headless narrow/light/dark previews                              |

Lifecycle: idle/hidden editors start no discovery or tests automatically. A user
request may finish while hidden, but closes/cancels when the editor unmounts.
Discovery is bounded to 20 seconds; profile testing to 225 seconds, sequentially
across at most five distinct models. Network failures stop the request without
retry loops. Native filesystem/catalog I/O runs on spawn_blocking. App identity
uses existing ORGII_HOME and ORGII_EXTERNAL_HISTORY_HOME paths; no extra global
response cache or account/session subscription was added.

The native CLI smoke test used isolated homes and a loopback server for Sonnet,
Opus, Fable, and Haiku, with tools disabled and synthetic credentials. It is not a
Claude Desktop/Tauri lifecycle benchmark. Windows execution, hidden/visible native
CPU/RSS, and repeated real-app open/close measurements were not run; desktop UI
control was not authorized.

Performance verdict: **blocked** for unmeasured native CPU/RSS and Desktop/Windows
lifecycle behavior. Bounded resources and stale-result invariants are covered by
automated tests; no measured performance improvement is claimed.
