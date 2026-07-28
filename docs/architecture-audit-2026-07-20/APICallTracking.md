# Architecture Audit — API Call Tracking

**Scope:** the Cmd+5 API panel's HTTP, Tauri IPC, event, channel, WebSocket, and SSE instrumentation.

## Acceptance criteria

- [x] Tracking remains enabled only while the Cmd+5 panel is open.
- [x] Axios, Fetch, direct XMLHttpRequest, and Tauri invokes appear in the call list.
- [x] Tauri events, both app IPC channels, both native WebSocket clients, ORG2 Cloud realtime, and every SSE event class feed the event/stream summary.
- [x] The data model describes transport (`http` / `tauri`), not a nonexistent Python-versus-Rust backend choice.
- [x] Active diagnostic groups are not hidden by the compact six-card limit.
- [x] Focused tests and lint pass.
- [ ] Full repository typecheck passes; currently blocked by one unrelated concurrent sidebar-test change listed in the delivery note.

## 10-layer review

| Layer | Coverage                      | Verdict        | Notes                                                                                                                                                                         |
| ----: | ----------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Compilation correctness       | partial        | Changed files pass ESLint and focused tests. Full `tsc --noEmit` reaches one unrelated sidebar-test error but no API-panel error after the XHR overload fix.                  |
|     2 | Dead code / duplication       | pass           | XHR coverage is installed from the same enable/disable lifecycle as Fetch and IPC. Axios-originated XHR is excluded to avoid duplicate records.                               |
|     3 | Naming consistency            | pass           | `BackendType` / `backend` were replaced throughout the monitoring domain with `ApiTransport` / `transport`.                                                                   |
|     4 | Semantic overloading          | fixed          | The old `python` value meant HTTP and the old `rust` value meant Tauri IPC, neither of which identified a backend correctly. Transport now names the actual dimension.        |
|     5 | Default branches              | pass           | No new catch-all variant behavior. HTTP and Tauri are handled explicitly where display or target resolution differs.                                                          |
|     6 | Cross-domain leakage          | pass           | Shared monitoring code knows transport mechanisms, not product backend variants or feature-specific state. Feature chokepoints only emit typed traffic observations.          |
|     7 | New-developer clarity         | pass           | `installXmlHttpRequestTracking`, `installTauriCallbackTracking`, and `transport` state their roles directly. Comments explain open-only installation and Axios deduplication. |
|     8 | Wire protocol / serialization | pass           | Instrumentation delegates the original XHR, Fetch, and Tauri arguments unchanged. No request or event payload schema is modified.                                             |
|     9 | Init parity                   | pass           | All instrumentation installs from `enableApiTracking` and is removed from `disableApiTracking`; there is no always-on alternate entry point.                                  |
|    10 | Resolver symmetry             | not applicable | No multi-field fallback resolver is present in this domain.                                                                                                                   |

## Transport coverage matrix

| Traffic class                    | Entry point                                 | Captured form             |
| -------------------------------- | ------------------------------------------- | ------------------------- |
| Axios HTTP                       | Axios interceptors                          | Individual call + hotspot |
| Fetch HTTP                       | `window.fetch` while open                   | Individual call + hotspot |
| Direct XHR                       | `XMLHttpRequest.open/send` while open       | Individual call + hotspot |
| Rust command IPC                 | Tauri `invoke` wrapper/internals            | Individual call + hotspot |
| Tauri events                     | global Tauri callback dispatcher            | Event/stream rate         |
| Session / ADE channels           | each app `Channel.onmessage` chokepoint     | Event/stream rate         |
| Code editor / session WebSockets | each native WS client message chokepoint    | Event/stream rate         |
| ORG2 Cloud realtime              | Postgres, Presence, and Broadcast callbacks | Event/stream rate         |
| SSE                              | start, output, end, and error callbacks     | Event/stream rate         |

No backend, Rust wire schema, initialization path, or resolver changed.
