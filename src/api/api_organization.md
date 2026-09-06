# API Layer Organization

Status: active  
Last edit: 0402

## Structure

```
src/api/
├── http/                          # Transport: REST via Axios
│   ├── client/                    # HTTP infrastructure
│   │   ├── index.ts               # Barrel
│   │   ├── types.ts               # DataField, RequestOptions, etc.
│   │   ├── config.ts              # API_BASE_URLS, timeouts
│   │   ├── requestHandler.ts      # makeRequest, makeDeleteRequest
│   │   ├── errorHandling.ts       # Error notifications
│   │   ├── tokenRefresh.ts        # Marketplace token refresh
│   │   ├── mainApi.ts             # getApi, postApi, etc.
│   │   ├── agentApi.ts            # getAgentApi, postAgentApi
│   │   └── marketplaceApi.ts      # getMarketplaceApi, postMarketplaceApi
│   │
│   ├── auth/                      # Auth endpoints (login, secure storage, token)
│   ├── billing.ts                 # Billing endpoints (flat file)
│   ├── config.ts                  # Config endpoints (flat file)
│   ├── git/                       # Git REST endpoints → local Rust HTTP :13847
│   ├── marketplace/               # Marketplace REST endpoints
│   ├── session/                   # Session REST + unified shims
│   ├── project/                   # SQLite-backed project / work item store
│   └── user/                      # User profile endpoints
│
├── tauri/                         # Transport: Tauri IPC (invoke)
│   ├── rpc/                       # Typed RPC layer (Zod) — THE standard for new commands
│   │   ├── index.ts               # rpc proxy, typedInvoke, defineProcedure
│   │   ├── invoke.ts
│   │   ├── router.ts
│   │   ├── transforms.ts
│   │   └── schemas/
│   │       ├── index.ts
│   │       ├── validation.ts
│   │       ├── settings.ts
│   │       ├── terminal.ts
│   │       └── diff.ts
│   │
│   ├── agent/                     # Agent commands (session, gateway, config, tools, etc.)
│   ├── session/                   # Aggregate session queries (cross-CLI/SDE/OS)
│   ├── search/                    # Code + semantic search subsystem
│   ├── perf/                      # Performance utilities (hash, binary, metrics)
│   ├── diff/                      # Diff computation (delegates to rpc)
│   ├── devRecord/                 # DevRecord Tauri commands
│   ├── repo/                      # Repo management Tauri commands
│   ├── github/                    # GitHub local Tauri commands
│   ├── learning/                  # Learning records
│   └── lineage/                   # Session impact lineage
│
├── realtime/                      # Transport: Persistent connections
│   ├── codeEditorWebSocket.ts     # WS to :13847/ws (file watch, LSP, git events)
│   ├── sseStream.ts               # Generic SSE stream utility
│   ├── taskStreaming.ts            # Task execution SSE (npm, yarn, etc.)
│   └── websocket/                 # Session WebSocket (agent message streaming)
│       ├── client.ts
│       ├── config.ts
│       ├── types.ts
│       ├── index.ts
│       └── WSProvider.tsx
│
├── services/                      # Stateful facades (business logic over API)
│   ├── keyValidation.ts           # Key CRUD facade over rpc.validation.*
│   └── notification.ts            # OS-level notification wrapper
│
├── types/                         # Shared API types
│   ├── index.ts
│   └── keys.ts
│
└── index.ts                       # Minimal: re-exports rpc and shared types only
```

## Transport Decision Guide

| Question                                      | Answer       | Use                                                     |
| --------------------------------------------- | ------------ | ------------------------------------------------------- |
| Talking to main backend (auth, billing, user) | Yes          | `http/`                                                 |
| Talking to local Rust HTTP server (:13847)    | Yes          | `http/git/`                                             |
| Calling Rust Tauri command with Zod schema    | Yes          | `tauri/rpc/`                                            |
| Calling Rust Tauri command without schema     | Yes (legacy) | `tauri/{domain}/`                                       |
| Long-lived WebSocket connection               | Yes          | `realtime/websocket/` or `realtime/codeEditorWebSocket` |
| SSE streaming from Rust server                | Yes          | `realtime/sseStream.ts` or `realtime/taskStreaming.ts`  |
| Business logic wrapping API calls             | Yes          | `services/`                                             |

## Adding New Code

### New Tauri command (preferred)

1. Add Zod schema in `tauri/rpc/schemas/{domain}.ts`
2. Register procedure in `tauri/rpc/router.ts`
3. Call via `rpc.{domain}.{command}()` — no raw `invoke()` needed

### New HTTP endpoint

Add to the appropriate domain folder under `http/{domain}/`.
Import HTTP helpers from `@src/api/http/client`.

### New realtime connection

Add to `realtime/`. SSE utilities are in `sseStream.ts`.

## Import Path Reference

| Module                       | Import path                             |
| ---------------------------- | --------------------------------------- |
| HTTP client (types, helpers) | `@src/api/http/client`                  |
| Auth endpoints               | `@src/api/http/auth`                    |
| Git endpoints                | `@src/api/http/git`                     |
| Marketplace endpoints        | `@src/api/http/marketplace`             |
| Session endpoints            | `@src/api/http/session`                 |
| User endpoints               | `@src/api/http/user`                    |
| Billing                      | `@src/api/http/billing`                 |
| Project / work items         | `@src/api/http/project`                 |
| Typed RPC                    | `@src/api/tauri/rpc`                    |
| Agent commands               | `@src/api/tauri/agent`                  |
| Session aggregate            | `@src/api/tauri/session`                |
| Search                       | `@src/api/tauri/search`                 |
| Diff                         | `@src/api/tauri/diff`                   |
| Perf utilities               | `@src/api/tauri/perf`                   |
| Orgtrack history             | `@src/api/tauri/orgtrackHistory`        |
| Repo commands                | `@src/api/tauri/repo`                   |
| GitHub local                 | `@src/api/tauri/github`                 |
| Learning                     | `@src/api/tauri/learning`               |
| Lineage                      | `@src/api/tauri/lineage`                |
| Code editor WebSocket        | `@src/api/realtime/codeEditorWebSocket` |
| Session WebSocket            | `@src/api/realtime/websocket`           |
| SSE stream                   | `@src/api/realtime/sseStream`           |
| Task streaming               | `@src/api/realtime/taskStreaming`       |
| Key validation service       | `@src/api/services/keyValidation`       |
| Notifications service        | `@src/api/services/notification`        |
| Key types                    | `@src/api/types/keys`                   |

## Future: Phase 3 — RPC Migration

Raw `invoke()` files under `tauri/{agent,search,session}` are legacy.
Migrate them to Zod schemas + `tauri/rpc/router.ts` one domain at a time.
`tauri/diff/` already delegates to `rpc` and shows the target pattern.
