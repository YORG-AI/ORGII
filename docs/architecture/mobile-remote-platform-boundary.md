# Mobile Remote platform boundary

**Date:** 2026-09-02
**Scope:** the first stacked iOS Remote change: extract a platform-neutral
Mobile Remote root and keep the existing Web Remote behavior behind a browser
adapter. This document does not claim that the Tauri iOS shell, Keychain,
Universal Links, APNs, or offline cache already exist.

## Decision and acceptance criteria

`MobileRemoteRoot` is the reusable product root. It owns authentication and the
existing Remote application lifecycle, but it does not choose a platform or
read browser globals. A shell must inject one `MobileRemotePlatform`; only the
shell-specific adapter may access navigation, credential storage, visibility,
timers, randomness, or construct the WebSocket.

This boundary is complete for this PR when all of the following are true:

- the standalone Web entry and the main-router compatibility entry both render
  the same `MobileRemoteRoot`;
- the shared root's static import graph cannot reach `platform/browser`, Tauri
  packages, or direct `window` / `document` / Web Storage access;
- auth, connection persistence, socket construction, timers, visibility, clock,
  randomness, and client identity are obtained from the injected platform;
- Web storage keys, OAuth PKCE behavior, relay JSON-RPC messages, transcript
  projection, and user-visible Web behavior remain compatible;
- stale auth, connection, subscription, and round-load completions remain
  rejected by their existing generation checks;
- tests cover the import boundary and the Web adapter path before a Tauri iOS
  adapter is introduced.

## Authoritative sources and ownership

| Concern                   | Authoritative source                                                                                          | In-memory owner                                                                         | Platform responsibility                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Agent/session history     | Desktop `EventStore`, exposed by `session/subscribe`, `session/round`, and live notifications                 | `TranscriptLoadState` in `MobileRemoteProviders` is a disposable projection             | Create the socket only; never invent, reorder, or persist transcript truth                                    |
| Round identity            | Desktop `roundId`; the submitting client contributes a stable `turnIntentId` until Desktop confirms the round | `transcriptLoadState.ts` owns provisional `local-pending:<turnIntentId>` reconciliation | Provide collision-resistant `randomUUID()`                                                                    |
| Event/tool identity       | Desktop `eventId` and `callId`                                                                                | `transcriptReducer.ts` performs canonical idempotent upserts                            | No platform-specific interpretation                                                                           |
| Signed-in account         | ORG2 Cloud/Supabase session plus the exchanged server session                                                 | `MobileAuthGate` and its generation-guarded reducer                                     | Store credentials, perform platform OAuth navigation/callback handling, and create the auth client            |
| Paired desktop connection | User-scoped connection configuration; Desktop/relay owns actual device authorization                          | `MobileRemoteProviders` owns the active transport and connection projection             | Persist the scoped config and construct the socket                                                            |
| Runtime lifecycle         | The currently mounted Remote root                                                                             | `MobileRemoteProviders` owns reconnect, subscription, refresh, and cleanup refs         | Supply timers and visibility notifications; native implementations must stop foreground-only work when hidden |
| Permission prompts        | Desktop interaction request stream                                                                            | `interactionQueueReducer.ts` owns FIFO presentation state                               | No durable copy in the platform adapter                                                                       |

The key invariant is that the phone never becomes an alternative transcript
database. Optimistic user content is a temporary client projection, identified
by `turnIntentId`, and is either reconciled to an authoritative `roundId`, kept
as uncertain after an indeterminate transport failure, or rolled back after a
definite rejection.

## Port contract

`MobileRemotePlatform` is intentionally split by responsibility rather than by
screen:

| Port         | Shared callers                            | Browser implementation                                         | Tauri iOS implementation requirement                                                                                     |
| ------------ | ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `runtime`    | Auth expiry, reconnect, UUIDs, visibility | `Date`, Web Crypto, `window` timers, Page Visibility           | WebView/app lifecycle bridge, secure UUID generation, deterministic timer cleanup                                        |
| `auth`       | `MobileAuthGate`                          | Supabase PKCE, browser location/history, session/local storage | System authentication browser, `org2remote`/Universal Link callback, PKCE verifier and refresh tokens in Keychain        |
| `connection` | `MobileRemoteProviders`                   | DOM WebSocket and user-scoped local storage                    | Foreground relay socket and encrypted retained pairing config; `save` calls must be serialized so latest invocation wins |
| `clientInfo` | JSON-RPC `initialize`                     | Web client name/version/default label                          | Native product name/version/device label without branching in shared code                                                |

The adapter object is immutable for the lifetime of a mounted root. Switching
platform objects in place is unsupported; remount the root instead. Shared UI
must not branch on `platform.kind`. A platform difference belongs in a port
implementation or, when it changes product behavior, in a new explicit
capability contract.

## Import graphs

### Web Remote

```text
mobileRemoteEntry.tsx
  -> getBrowserMobileRemotePlatform()
  -> captureInitialPairingIntent() before asynchronous startup
  -> I18nextProvider
  -> MobileRemoteRoot(platform)
       -> MobileRemotePlatformProvider
       -> MobileAuthGate
       -> MobileRemoteApp
            -> MobileRemoteProviders
            -> navigation / transcript / interaction reducers

BrowserMobileRemotePage.tsx
  -> getBrowserMobileRemotePlatform()
  -> captureInitialPairingIntent() at lazy-module evaluation
  -> MobileRemoteRoot(platform)
```

Only `mobileRemoteEntry.tsx`, `BrowserMobileRemotePage.tsx`, and
`platform/browser/**` may import the browser adapter. Both Web entries perform
the security-sensitive capture and URL scrubbing synchronously before mounting
auth: the standalone entry does so before asynchronous i18n startup, while the
main-router page does so when its lazy route module is evaluated.

### Tauri iOS target

```text
Tauri iOS shell / WebView entry
  -> createIosMobileRemotePlatform(native bridges)
  -> receive Universal Link or org2remote callback before root bootstrap
  -> I18nextProvider
  -> MobileRemoteRoot(platform)
       -> the same MobileAuthGate, MobileRemoteApp, providers, reducers and UI
```

The iOS graph must import `MobileRemoteRoot` and `platform/types`; it must not
import `BrowserMobileRemotePage` or `platform/browser`. Conversely, shared
Mobile Remote modules must not import the future iOS adapter. This is what
allows a lightweight Tauri target without compiling the Desktop Rust runtime.

## State machines and stale-result protection

| State owner             | States/epochs                                                                                                     | Valid progress                                                                              | Stale/late handling                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Auth reducer            | `checking`, `signed_out`, `redirecting`, `exchanging`, `signed_in`, `error`; auth generation                      | check/redirect/exchange -> signed in or error; sign-out is immediate in UI                  | Writes are followed by generation checks; sign-out waits for pending authentication, and a new sign-in waits for sign-out cleanup       |
| Connection projection   | `disconnected`, `connecting`, `connected`, `error` plus orthogonal presence and demo flags; connection generation | load config -> connect -> initialize -> connected; close -> reconnect while visible         | Bootstrap/load and socket callbacks check their generation; a stale socket must still own `socketRef` before its close callback can act |
| Transcript load reducer | index phase, selected round, per-round body phase; subscription and request generations                           | subscribe -> index/snapshot -> lazy round body; live upserts merge through the same reducer | Wrong session/generation/round/request results are ignored; full snapshots replace baselines                                            |
| Send lifecycle          | `submitting`, `accepted`, `completed`, `failed`, `cancelled`, `uncertain` keyed by `turnIntentId`                 | optimistic pending round -> Desktop acknowledgement -> authoritative round confirmation     | Definite rejection rolls back; indeterminate transport failure retains the pending item for later EventStore reconciliation             |
| Permission queue        | FIFO request queue                                                                                                | enqueue notification -> respond/dismiss -> dequeue                                          | A response is sent only for the current head; disconnect clears disposable requests                                                     |

These machines describe separate dimensions. In particular, transport
presence must not be used as transcript authority, and send completion must not
be inferred from arbitrary streaming text. Durable Desktop snapshots and
identity-bearing terminal messages perform reconciliation.

## Error and lifecycle matrix

| Condition                               | Required behavior                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OAuth callback replay/missing attempt   | Fail closed; do not exchange a callback without its retained PKCE attempt                                                                        |
| Permanent auth/session rejection        | Clear the retained auth session and show a non-retryable error                                                                                   |
| Retryable auth/network error            | Keep enough rotating-token state to retry without replaying a scrubbed callback                                                                  |
| App hidden                              | Cancel reconnect timers, release the foreground socket, and do not maintain a permanent background connection                                    |
| App visible with retained active config | Reconnect only when no client is active                                                                                                          |
| Socket closes after authentication      | Release transient transport, preserve the active configuration, and schedule bounded backoff                                                     |
| Explicit disconnect/sign-out            | Bump generations before cleanup; connection writes are serialized, sign-out waits for pending auth, and a new sign-in waits for sign-out cleanup |
| Session or round request races          | Accept only the active session, subscription generation, selected round, and request generation                                                  |
| Definite send failure                   | Remove that exact `turnIntentId` provisional round                                                                                               |
| Indeterminate send failure              | Show `uncertain` and retain the provisional round until authoritative replay resolves it                                                         |

The shared owners order storage mutations: the provider serializes connection
writes, and the auth gate sequences write guards, pending-auth cleanup, and the
next sign-in. Native adapters must preserve these completion semantics and make
each individual Keychain/config mutation atomic.

## Wire and compatibility contract

- The relay remains JSON-RPC 2.0 over `ws`/`wss`; the adapter changes socket
  construction, not method names or payload interpretation.
- `initialize.protocolVersion` remains `1`. Platform data only supplies
  `clientInfo` and the default device label.
- `session/send` continues to carry a unique `turnIntentId`,
  `turnIntentSource: "mobile_remote"`, and an attachments array.
- A round index with `turnIntentId` is preferred. Older Desktop builds can be
  reconciled from the identity on the opening user event in the latest full
  snapshot; positional and text-only matching remain forbidden.
- Missing round-history support continues through the existing legacy latest
  snapshot path. Optional capabilities must be treated as unavailable, not
  synthesized by an adapter.
- Browser storage keys and payload shapes remain owned by the existing pure
  storage helpers; the browser adapter delegates to them rather than defining a
  parallel format.

No schema generator is introduced by this refactor. The network bytes are
still produced by `mobileRpcClient.ts` using `JSON.stringify`. Provider tests
assert the complete `initialize` and `session/send` request objects, including
platform client identity, capabilities, device label, `turnIntentSource`, and
attachments.

## Entry-point initialization parity

| Entry                          | Platform constructed             | Pairing/deep link captured before auth                          | i18n ready                       | Shared root                         | Auth -> provider order |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------- | -------------------------------- | ----------------------------------- | ---------------------- |
| Standalone Web entry           | Browser singleton                | Yes, synchronously before async i18n                            | Yes                              | Yes                                 | Yes                    |
| Main-router compatibility page | Browser singleton                | Yes, synchronously at lazy-module evaluation before auth mounts | Supplied by main app             | Yes                                 | Yes                    |
| Tauri iOS entry (next PR)      | Native adapter                   | Required in the native link handler before mounting             | Required                         | Yes                                 | Yes                    |
| Unit/component tests           | Explicit browser or test adapter | Seeded directly by the test                                     | Explicit provider where rendered | Yes where integration is under test | Yes                    |

Both Web paths now scrub pairing data before their auth root mounts. The
standalone path remains the earliest capture because it runs before i18n and
the rest of the public Mobile Remote bootstrap; the main-router path runs when
the lazy route module is evaluated.

## Resolver symmetry

| Resolved concern  | Primary source                    | Retained source                                | Required finalization                                              |
| ----------------- | --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| Auth session      | PKCE callback exchange            | Platform auth store and refresh                | Persist rotated session, then establish server session             |
| Pairing intent    | Initial opaque link capture       | Platform intent store                          | Consume only after successful account authentication               |
| Connection config | Explicit `relayUrl` when supplied | User-scoped platform connection store          | Persist through the same platform port before connecting           |
| Transcript round  | Exact `roundId`/round directory   | Identity-bearing full/live EventStore snapshot | Reconcile only with `turnIntentId`; never by list position or text |

The two auth paths deliberately differ only at acquisition (callback exchange
versus restore/refresh); both converge on persistence, server-session exchange,
pairing-intent consumption, and the same signed-in reducer event.

## Ten-layer architecture audit

| Layer                                   | Evidence and verdict                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | `pnpm typecheck` passes after the cross-domain call-site sweep. The targeted Mobile Remote suite passes 30 files / 144 tests, including the 5-test platform-neutral static boundary. No Rust change is in this PR; the future native shell requires its own `cargo check`/iOS build evidence.                                                                                                           |
| 2. Dead code and structural duplication | The port is reached from both production Web entries, `MobileAuthGate`, `MobileRemoteProviders`, settings, and RPC timers. Browser auth/storage/socket logic exists only in `platform/browser`; the old shared auth client implementation is removed rather than retained as a second path.                                                                                                             |
| 3. Naming consistency                   | `MobileRemoteRoot`, `BrowserMobileRemotePage`, `MobileRemotePlatform`, and the `runtime`/`auth`/`connection` suffixes describe ownership. Existing external JSON-RPC names are unchanged.                                                                                                                                                                                                               |
| 4. Semantic overloading                 | `session` means either ORG2 Cloud auth session or Desktop agent session and always carries an `Auth`/RPC context; `generation` is local to auth, connection, subscription, or round request and is not a global revision; `connection` distinguishes persisted `MobileConnectionConfig`, projected `MobileConnectionState`, and the `ConnectionPort`. These distinctions must remain in names and docs. |
| 5. Default branches                     | Platform selection has no shared default: every root must receive a platform. Capability absence means unavailable, and an initialize response without a permission tier now fails closed to `read_only` rather than silently granting write access.                                                                                                                                                    |
| 6. Cross-domain leakage                 | Static graph tests prevent the neutral root from reaching browser/Tauri adapters or browser globals. `WebSocket` remains the connection port's structural transport type; this is an explicit WebView-v1 constraint, not a claim of native-socket neutrality.                                                                                                                                           |
| 7. New-developer clarity                | The root/adapter import diagrams, ownership table, latest-write storage contract, and shell responsibilities are documented here. Shared components do not inspect platform kind.                                                                                                                                                                                                                       |
| 8. Wire protocol                        | No method/schema rewrite occurs. Platform client identity is the only new `initialize` input. Provider tests assert the complete `initialize` and `session/send` parameter shapes, while RPC tests exercise JSON-RPC serialization and response correlation.                                                                                                                                            |
| 9. Initialization parity                | Both Web entries capture the pairing intent before auth and converge on `MobileRemoteRoot -> MobileAuthGate -> MobileRemoteApp`. The future native entry must perform its corresponding deep-link capture before the same root.                                                                                                                                                                         |
| 10. Resolver symmetry                   | Callback and restored auth sessions converge on the same finalization chain; explicit/persisted connection configs converge on the same connect path; pending/authoritative rounds converge only through stable identity. The matrices above document allowed asymmetry.                                                                                                                                |

## Test boundaries

| Boundary                      | Required evidence in this PR or the next owning PR                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure reducers                 | Auth stale-generation rejection; transcript full/delta replacement, pending-round reconciliation, out-of-order session/round results; permission FIFO        |
| Platform-neutral import graph | `MobileRemoteRoot` cannot reach `platform/browser`, browser globals, Desktop/Tauri-only modules, or `@tauri-apps/*`                                          |
| Browser adapter               | PKCE callback rejection/restore, storage delegation, visibility subscription cleanup, timer injection, socket factory and client identity                    |
| Provider integration          | Connect/initialize, reconnect/unmount cleanup, optimistic send/uncertain failure, exact round confirmation, settings projection without direct storage reads |
| iOS adapter (next PR)         | Contract tests using Keychain/deep-link/lifecycle fakes, plus a real-device OAuth return and pairing flow                                                    |
| Release acceptance            | iPhone foreground/background transitions, network loss/recovery, expired login, revoked pairing, loading/empty/error states, Dynamic Type and VoiceOver      |

## Remaining risks and staged ownership

1. **No native implementation is present yet.** This PR establishes the seam;
   the next PR must add the Tauri iOS target, Keychain-backed auth/connection
   stores, system-browser callback, Universal Link handling, and adapter
   conformance tests.
2. **The shared connection port currently returns DOM `WebSocket`.** This is
   compatible with the Tauri WebView v1 design. If background/native sockets
   become necessary, replace it with a minimal socket interface rather than
   importing a native plugin into shared code.
3. **Auth and connection stores are asynchronous on native.** The shared
   provider now serializes connection saves, and the auth gate orders pending
   authentication, final sign-out cleanup, and subsequent sign-in. The iOS
   adapter still must make each Keychain/config mutation atomic and must not
   resolve a write before durable completion.
4. **`MobileRemoteProviders` remains a large orchestration owner.** This PR
   deliberately extracts environment dependencies without rewriting the
   working transcript/send/reconnect state machines. Future decomposition must
   preserve one dispatcher, the existing generation guards, and the canonical
   reducers rather than create parallel iOS logic.
5. **APNs, conditional Desktop keep-awake, encrypted seven-day/50-session/200MB
   cache, and no-queued-offline-action policy belong to later staged PRs.**
   They must consume the same durable Desktop identities and must not turn push
   payloads or cache rows into a second source of transcript truth.
