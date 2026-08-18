# Identity authentication Phase 5/6 architecture audit

Date: 2026-08-18

Scope: realm-scoped failures, account switching, reauthentication intent recovery,
identity-bound cache invalidation, Account Center repair UI, and safe removal of
retired Hosted credential compatibility. The final Cloud compatibility deletion
is intentionally gated on the separate Cloud deployment.

## Outcome

- Phase 5 is implemented locally: authentication failures name their realm and
  originating session, account switching fences stale refreshes with a Broker
  generation, identity-bound Cloud caches are evicted before the new projection
  is published, and a successful reauthentication resumes a one-shot safe
  intent.
- The safe local portion of Phase 6 is implemented: retired Hosted/Supabase
  credential keys, the development WebKit credential importer, and its debug IPC
  command are removed. `authSkipped` remains a plain local preference rather
  than credential state.
- Final Cloud compatibility deletion is not ready. On 2026-08-18 the official
  `https://org2-cloud-infra.vercel.app/api/auth/desktop/config` endpoint returned
  HTTP 404. The Code + PKCE server implementation exists in the separate
  `/Users/junyu/github/ORGII-cloud-infra-identity-auth` worktree but is not
  deployed, so the rollout-only Cloud legacy envelope remains inventoried.

## State machines and invariants

### Identity transition

| Event | Required transition | Enforced invariant |
| --- | --- | --- |
| Begin reconnect/account switch | Persist a new realm generation before opening the browser | An older refresh/code completion cannot commit into the new generation. |
| Snapshot will change | Synchronously reset Cloud identity-bound caches | Account A data is absent before account B becomes visible. |
| Authenticated snapshot | Publish a non-secret projection and resolve a matching intent | A task resumes only for the exact flow/generation that staged it. |
| Cancel/failure/timeout | End loading and retain the prior verified projection where valid | The user is not trapped in a global loading state. |
| Sign out | Invalidate the session generation and clear realm-local state | Other identity/provider realms are not signed out. |

### Sign-in intent

The intent is a memory-only discriminated union with a ten-minute TTL. Routes
must be internal safe paths; identifiers are opaque validated values. An intent
is bound to the Broker flow ID and generation after sign-in starts, consumed at
most once, and never contains invite/share bearer material. Invite and share
secrets remain in their existing purpose-specific in-memory atoms.

### Failure ownership

`ApiAuthFailure` carries `realm`, `sessionId`, and `reason`. Hosted requests
capture their session when the request begins, so a late 401 cannot mark a newer
session as failed. The generic request path reports a typed failure and does not
perform global logout; the realm adapter decides repair behavior.

## Boundary and edge-case matrix

| Case | Expected behavior | Evidence |
| --- | --- | --- |
| Account A refresh completes after account B switch starts | The generation/CAS fence rejects A's completion | Rust `account_switch_generation_supersedes_an_in_flight_refresh` test. |
| Account A cache exists when account B projection arrives | Cache is empty before the projection listener observes B | `org2CloudIdentityLifecycle.test.ts`. |
| Hosted 401 arrives after a new Hosted session exists | Failure remains attributed to the originating session | Request isolation and auth-failure tests. |
| GitHub/Agent/Hosted failure | No unrelated Cloud/global logout | Typed realm adapters and client tests. |
| Unsafe/external resume route | Intent is rejected | `signInIntent.test.ts`. |
| Callback belongs to a different flow/generation | Intent remains pending and does not navigate | `signInIntent.test.ts`. |
| Intent expires or has already been consumed | No navigation/replay | TTL and one-shot tests. |
| Invite/share triggers sign-in | Non-secret intent resumes while the sensitive payload stays in its owning atom | Sign-in hook and entry-point tests. |
| Debug build accesses credentials | Process-local memory store; no macOS Keychain prompt | Broker profile selection and tests. |
| Release secure store is unavailable | No plaintext fallback | Credential-store contract and secret-boundary scan. |

## Ten-layer architecture audit

| Layer | Coverage and verdict |
| --- | --- |
| 1. Compilation | TypeScript, production webpack build, Rust Broker release check, Broker tests, and application identity tests pass. New failure and intent types are explicit discriminated/domain types. |
| 2. Dead code/dedup | Removed the global login guard/modal/fixed-port path, renderer refresh ownership, retired Hosted token modules, WebKit scanner, debug import command, and Hosted legacy-migration IPC. Cloud compatibility remains only for the undeployed rollout gate. |
| 3. Naming | Public concepts use realm, session, flow, generation, intent, and credential-store terminology. `authSkipped` is documented and implemented as a UI preference, not authentication state. |
| 4. Semantic overloading | Product identity, Hosted identity, GitHub/provider connections, BYOK credentials, and authorization/entitlement remain separate. No generic `isAuthenticated` or catch-all realm behavior was added. |
| 5. Default branches | Realm and intent unions use explicit variants. Unknown/unsafe routes and unmatched flows fail closed rather than inheriting Cloud behavior. |
| 6. Cross-domain leakage | Realm-scoped failures and sign-out paths do not delete unrelated provider credentials. Public identity snapshots and UI events contain no refresh token or PKCE verifier. |
| 7. Developer clarity | Rust Identity Broker owns login, refresh, generation and credential persistence. Frontend lifecycle modules own projection subscription, pre-publish invalidation, and intent recovery. Migration-only Cloud ownership is named and documented. |
| 8. Wire protocol | Desktop OAuth uses code/state/error callbacks with PKCE; Broker DTOs expose only non-secret projections and short-lived access leases. Hosted legacy migration commands are gone. The Cloud server contract is implemented in its own repository but cannot become the default until deployed. |
| 9. Initialization parity | Identity lifecycle installs projection, cache-invalidation, auth-failure and intent listeners before initial hydration; installers are idempotent. Debug uses the same product flow with process-local credentials. Cross-platform live verification remains outstanding. |
| 10. Resolver symmetry | A usable session is resolved from a coherent realm/session/issuer/subject/generation tuple. Endpoint changes and account changes invalidate the same Cloud-owned caches; no identity is inferred from a stray token or user field. |

## Performance and lifecycle guard

| Lifecycle state | Behavior | Verdict |
| --- | --- | --- |
| Normal active use | Broker refresh is single-flight per session; 100 concurrent callers share one refresh result. | Pass. |
| Idle | No polling or timer was added. A staged sign-in intent is one bounded memory object with TTL-on-read. | Pass. |
| Hidden/background | Existing focus reconciliation keeps its cooldown; this change adds no background loop. | Pass. |
| Repeated mount/unmount | Global identity lifecycle installers are idempotent and do not accumulate listeners. | Pass. |
| Multi-window | The native Broker owns process session/generation state; frontend projections reconcile by revision. | Pass at contract/unit level; live multi-window smoke remains outstanding. |
| Account/endpoint switch | Generation changes and synchronous cache reset prevent stale data from surviving the boundary. | Pass. |

No new unbounded collection, full-data scan, retry loop, or idle-time I/O was
introduced. Existing product sync/realtime scheduling is outside this change.

## UI audit

The Account Center change uses the existing `Button`, `Input`, spacing and
semantic color tokens. The two component audit reports contain zero immediate
fixes, nine documented keep decisions, and one shared abstraction candidate for
a generic semantic status badge. That candidate is intentionally left for a
separate design-system sweep rather than creating a partial convention here.

## Verification performed

- `npm test -- --run` — full Vitest suite passed.
- `npm run build` — production webpack build passed.
- `npm exec tsc -- --noEmit --pretty false` — passed.
- `npm run check:identity-secret-boundaries` — passed; only the documented
  Cloud rollout migration store remains.
- `npm run check:i18n:cloud` — all navigation keys are complete in every locale.
- Targeted ESLint for the changed identity/account UI files — passed.
- `cargo test -p identity-broker` — 21 tests passed.
- `cargo clippy -p identity-broker --all-targets -- -D warnings` — passed.
- `cargo check --release -p identity-broker` — passed.
- `cargo test -p org2 identity:: --lib` — 10 tests passed, including the
  100-concurrent-caller single-flight case.
- `cargo clippy -p org2 --lib --no-deps -- -D warnings` and
  `cargo check -p org2` — passed.
- `cargo check --workspace --all-targets` — passed.
- `rustfmt --check` over every changed Identity Broker/application identity Rust
  source — passed.
- `git diff --check` — passed.

## Remaining gates and risk

1. Deploy the separate Cloud Code + PKCE implementation, verify its config,
   authorize, token and callback contracts with a real account, then enable the
   Broker Cloud path by default.
2. Only after that successful rollout, delete the Cloud fragment callback,
   loopback compatibility receiver, legacy envelope/import command, and
   `shared-service-auth.json`, then rerun release-artifact secret scans.
3. Run real-account macOS smoke tests and the Windows/Linux secure-store and
   loopback matrix. Unit/contract coverage does not substitute for those live
   platform checks.
4. Capture rendered Account Center evidence in an authenticated app. No visual
   screenshot is included because this run did not launch or mutate a real
   user account/session.
5. Phase 7's full typed Rust Cloud gateway remains a separately scoped hardening
   phase; the renderer currently receives only short-lived access leases, never
   refresh tokens.
6. The repository-wide `cargo clippy --workspace --all-targets -- -D warnings`
   gate is blocked by a pre-existing `collapsible_else_if` finding in
   `crates/orgtrack-core/src/sources/imported_history/window.rs:189`; the scoped
   Identity Broker and `org2 --lib --no-deps` Clippy gates pass. Full
   `cargo fmt --all -- --check` likewise reports unrelated existing formatting
   differences in the Canvas/turn-window worktree changes; the identity files
   themselves pass `rustfmt --check`.
