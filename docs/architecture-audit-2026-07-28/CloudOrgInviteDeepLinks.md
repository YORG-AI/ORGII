# Cloud organization invite deep-link audit

## Scope and acceptance criteria

This audit covers the organization-invite path from link creation through the
HTTPS handoff page, native app activation, authentication, invite acceptance,
and organization refresh.

The feature is accepted when:

1. A newly created invite is copied as a clickable HTTPS URL.
2. The plaintext invite capability stays in the URL fragment and is not sent
   to the handoff web host.
3. The handoff opens `orgii://cloud/join?invite=…` and preserves direct native
   links for backward compatibility.
4. Cold-start and already-running app paths both deliver the invite to the
   same frontend owner.
5. Signed-out users can authenticate without losing the pending invite.
6. Success refreshes membership and clears the pending invite; backend errors
   remain visible and retryable.

## Lifecycle and ownership

| Stage | Authoritative owner | State transition |
| --- | --- | --- |
| Create | `createCloudInvite` | Generate 32 random bytes locally, send only the SHA-256 hash to `create_invite`, return the plaintext once |
| Share | `buildCloudInviteLink` | Encode the plaintext as `#invite=` on the fixed HTTPS handoff origin |
| Handoff | deployed `orgii-invite` site | Validate a 64-character hex capability and launch the native `orgii://cloud/join` URL |
| OS delivery | Tauri deep-link plugin | Deliver cold-start URLs through `getCurrent` and live URLs through `onOpenUrl` |
| Warm-instance recovery | Tauri single-instance plugin | Forward Windows/Linux deep-link argv before the callback, then restore or recreate the main window |
| Route | `useDeepLinkHandler` | Parse the native URL, set `org2CloudPendingInviteAtom`, and open Workstation |
| Authenticate | `JoinCloudOrgDialog` | Keep the pending capability while the user signs in |
| Accept | `acceptCloudInvite` | Hash the plaintext locally, call `accept_invite`, and refetch until membership is visible |
| Terminal | `JoinCloudOrgDialog` | Clear pending state on success or explicit dismissal; retain it on retryable failure |

The frontend hook is the single routing owner. Rust restores application
availability but does not parse, persist, or log invite capabilities.

## State and edge-case matrix

| Condition | Expected behavior | Coverage/evidence |
| --- | --- | --- |
| New generated link | HTTPS link contains `#invite=` and no query | Unit test |
| Existing direct native link | Parsed and routed unchanged | Existing parser/hook tests |
| Legacy HTTPS query link | Accepted when the fixed origin/path match | Unit test and handoff-site test |
| Fragment and query both present | Non-empty fragment wins | Unit test and handoff-site test |
| Empty fragment invite plus query | Query fallback is used | Unit test |
| Foreign HTTP(S) or other scheme | Rejected instead of treated as a raw code | Unit test |
| App cold start | `getCurrent` drains the initial native URL | Code-path audit; manual acceptance |
| App already running | `onOpenUrl` receives the forwarded URL and the window is restored | Plugin source/config audit; manual acceptance |
| User signed out | Pending invite remains while login is requested | Dialog state-path audit |
| Invite valid | Membership refreshes, organization becomes selectable, pending state clears | Manual acceptance with a second account |
| Invite exhausted | Backend error remains visible and retryable | Manual acceptance |
| Duplicate join click | Join control is disabled while acceptance is in flight | Dialog state-path audit |

## Architecture audit

| Layer | Verdict | Evidence |
| --- | --- | --- |
| 1. Compile and baseline | Pass | Targeted ESLint, TypeScript typecheck, 71 frontend tests, and `cargo check -p org2` pass |
| 2. Structural uniqueness | Pass | One HTTPS builder, one native parser, one app-lifetime routing hook, and one pending-invite atom |
| 3. Naming and semantic clarity | Pass | “HTTPS handoff link,” “native deep link,” plaintext “invite code,” and on-wire “invite hash” remain distinct |
| 4. Type/domain soundness | Pass | Generated invite codes retain the 32-byte/64-hex invariant; link parsing returns `null` on invalid URL boundaries |
| 5. Branch/default behavior | Pass | Missing capability, foreign origin/path, missing window, sign-out, backend failure, and success each have explicit outcomes |
| 6. Domain ownership | Pass | Cloud invite parsing/building stays in `Org2Cloud`; Rust owns only process/window lifecycle |
| 7. Developer clarity | Pass | Comments explain fragment privacy, compatibility parsing, plugin order, and why argv must never be logged |
| 8. Wire/storage contracts | Pass | Only SHA-256 hashes cross management RPCs; the plaintext exists only in the share URL/native delivery path |
| 9. Initialization parity | Pass | Cold `getCurrent`, warm `onOpenUrl`, and second-process forwarding converge on `routeToCloudJoin` |
| 10. Data-shape alignment | Pass | App and handoff page use the same fragment-first/query-fallback precedence |

The full `cargo fmt --check` command reports pre-existing formatting
differences in unrelated `agent_sessions` files on the `develop` baseline.
The changed Rust file passes a scoped `rustfmt --check`, and no unrelated
formatting changes are included.

## Verification

- `pnpm vitest run` on invite management, management client, deep-link handler,
  and billing-completion suites: 4 files, 71 tests passed.
- Targeted ESLint on all changed TypeScript/TSX files: passed.
- `pnpm run typecheck`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml -p org2`: passed.
- Deployed handoff source: lint passed, production build passed, 5 tests passed.
- Manual acceptance: owner generated an invite for `ORG2-Invite-Test`; a
  different signed-in account opened the HTTPS link and joined successfully.
  An exhausted invite displayed the backend “no uses left” error.

## Remaining risks and non-goals

- The handoff site is deployed from a separate site repository, so its
  production URL is an external runtime dependency rather than part of this
  application PR.
- Custom-scheme registration still requires an installed build containing the
  `orgii` scheme; browser-only joining and app-store installation fallback are
  not part of this change.
- Automated WebDriver tests enter at the parsed deep-link boundary because
  they cannot generate an operating-system URL-open event. Cold/warm OS
  dispatch therefore retains manual acceptance coverage.
