# PR 552 dual-instance live test — invite HTTPS handoff + single-instance

Protocol: `.orgii/skills/dual-instance-verification/SKILL.md`. Builds: both
instances from worktree `~/Projects/orgii-wt-pr552` (head `cc413d26e`);
inst-1 = `ORG2.app` (yorg.orgii, data `~/.orgii`, account vinceorz),
inst-2 = `ORG2 Instance 2.app` (yorg.orgii.instance2, data
`~/.orgii-instance2`, account vinceorz418). Scheme note: `orgii://` routes to
inst-1 only (inst-2 claims `orgii-instance2://`), so inst-2 exercises the
paste-into-join-dialog arm — which is precisely the new
`parseCloudInviteInput` HTTPS path.

## Environment constraint (shapes the whole run)

Screen-control access was denied for the first (headless) pass, then granted
by the user; the UI-click cells (U1–U4 below) were completed in a second pass.
Both instances were signed in to the **same** cloud identity
(`vinceorz@hotmail.com`, sub `394af2b7`) throughout — so a real cross-account
"second account joins" flow was not possible (you cannot accept your own org's
invite; entering credentials for a second account is outside what the agent
may do). The headless pass targets exactly the code paths PR 552 _changes_ —
the Rust single-instance plugin, the OS `orgii://` deep-link dispatch/routing,
the server invite RPC round-trip, and the deployed handoff site — driven via
`open`, service-key RPC, log/ledger inspection, and in-app Browser network
capture. Cross-account-accept remains UNCOVERED below with reason.

## Cell matrix (result)

| Cell   | Scenario                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B      | Warm deep link `orgii://cloud/join?invite=<real 64hex>` → running inst-1      | **PASS** — frontend `[DeepLinkHandler] Routing ORG2 Cloud invite into join confirmation`; process set unchanged (no stale bundle launched)                                                                                                                                                                                                                                                                                        |
| C      | Second process (`open -n` of the exact worktree bundle) forwards + exits      | **PASS** — 2nd pid 31268 forwarded and exited; sole survivor = inst-1; backend `external open request forwarded to the running app argument_count=1` (count only)                                                                                                                                                                                                                                                                 |
| F      | Cold start: quit inst-1, `open -a <bundle> orgii://…invite=`                  | **PASS** — new pid 32531 cold-booted; frontend `Routing initial ORG2 Cloud invite into join confirmation` (the `getCurrent` drain path)                                                                                                                                                                                                                                                                                           |
| M      | Fault: `orgii://cloud/join` (no invite), `?invite=` (empty), `cloud/nonsense` | **PASS with baseline caveat** — all received, **zero** "Routing … invite" lines, no process crash, process set stable. But malformed `cloud/*` links are not fully no-op: they fall through to the generic `parseDeepLink` conversion and navigate to `/orgii/cloud/…`, which no real route matches, so the router's 404 catch-all renders `<ErrorPage />` ("Something went wrong"). Root-caused below — **baseline**, not PR 552 |
| N      | Log privacy: plaintext code in any log                                        | **PASS** — code `624f…8582` absent from every inst-1/inst-2 frontend+backend log; argv logged as count only                                                                                                                                                                                                                                                                                                                       |
| O      | Destructive-effect verb audit (both instances, test window)                   | **PASS** — only hit was a routine housekeeping GC (`session_cache_rows_evicted=1`), unrelated to invites                                                                                                                                                                                                                                                                                                                          |
| P      | Fleet ledger before/after (1431 sessions / 192 orgs / 273 members)            | **PASS** — invite flow footprint = **+1 org, +1 membership, 0 session rows**; 3 session-level deltas (1 add, 1 epoch 23→24, 1 soft-delete @16:02:21Z _before_ the test) all in the live workspace org `bfa7b134`, none in the test org, none producible by this PR's diff                                                                                                                                                         |
| Server | `create_org` + `create_invite` RPC round-trip                                 | **PASS** — only the SHA-256 hash crossed the wire (`invite_code_hash`); plaintext stayed local; returned `inviteId`                                                                                                                                                                                                                                                                                                               |
| Site   | Deployed handoff page with the **real** fragment                              | **PASS** — recognized the code ("Invite code ending in **8582**"), rendered "Open ORG2 →"; network capture shows **no** request carrying `invite=`/the code — only static assets + Cloudflare challenge JSD                                                                                                                                                                                                                       |

## UI cells (second pass, screen access granted)

Test org: `PR552 UI Invite Test` (`aaf35493…`), created from inst-1 UI as
vinceorz (owner); invite Member / 1 use / 7 days, code `f94a…2d12c`.

| Cell | Scenario                                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1   | Create invite via Manage Org UI (inst-1), inspect rendered link                                                    | **PASS** — invite created; rendered link is the new HTTPS handoff form (`https://orgii-invite-link.atah2000.chatgpt.site/#invite=<64hex>`), live-confirming audit finding 1's premise; join-dialog placeholder still says `orgii://` (finding 4 live-confirmed)                                                                                                                                                     |
| U2   | Paste the rendered **HTTPS** link into inst-2's Add ORG → Cloud → Join dialog and submit                           | **PASS (PR-relevant path)** — the link is accepted by `parseCloudInviteInput`, the `accept_invite` RPC fires and the server processes it. The visible failure is a **pre-existing** edge (below): the tester owns the org, the server returns `role:"owner"`, and `AcceptInviteResponseSchema` (admin\|member) rejects the response with a raw Zod error. Round-trip through the new parse path verified end-to-end |
| U3   | Submit `orgii://collaboration/join?invite=notaninvite` (valid scheme, wrong host)                                  | **PASS** — friendly "This invite code isn't valid." (`invalid_invite` thrown by `joinOrganization` before any RPC)                                                                                                                                                                                                                                                                                                  |
| U4   | Submit `https://evil.example.com/#invite=<64hex>` (foreign origin, real-shaped code) from a freshly remounted form | **PASS** — fresh "This invite code isn't valid." appears from a clean no-error state; the origin check rejects client-side, no RPC. (First attempt was ambiguous because the previous error banner shows identical text; the form was remounted via Session→More→Add ORG to make the assertion clean)                                                                                                               |

### Pre-existing defects observed while driving the UI (NOT PR 552)

1. **Owner self-accept consumes the invite and returns an unparseable role.**
   Server-side `accept_invite` succeeded for the org owner — inst-1's Manage
   Org page now shows the invite as **"Used up"** — and returned
   `role:"owner"`, which the client's `AcceptInviteResponseSchema`
   (`admin|member`) rejects, dumping a raw Zod error into the join dialog.
   Two layered issues: the server neither rejects self-accept nor refunds the
   use, and the client renders a schema dump instead of a friendly error.
   Attribution: the accept path is untouched by PR 552's diff.
2. **Malformed `orgii://cloud/*` deep links land on the error page and it
   survives restart.** Root cause chain (all baseline code, none of it in the
   PR diff): `parseCloudInviteDeepLink`/session parser return null → generic
   `parseDeepLink` (`useDeepLinkHandler.ts:108`) converts any leftover URL to
   `/orgii/<host>/<path>` → no real route matches `/orgii/cloud/…` (a valid
   invite never navigates there; `routeToCloudJoin` uses a pending-invite atom
   - the workstation route) → the router's 404 catch-all
     (`src/router/index.tsx`, `path:"*"`) renders `<ErrorPage />` — the same
     alarming "Something went wrong" screen used for real errors. Worse, the
     initial-deep-link drain re-navigates on every boot (log 09:33:13
     "Navigating to initial deep link: /orgii/cloud/nonsense?x=1"), so the
     error page reappears after Restart — it looks like a crash loop but is
     stale-link re-delivery into a 404. The comment in `parseDeepLink` claiming
     `orgii://cloud/join` "never reach[es] this generic conversion" is false
     for malformed variants. `useDeepLinkHandler.ts` and `router/index.tsx` are
     both absent from PR 552's changed-file list (last touched by the
     session-reference commits), so this is **baseline**, surfaced — not
     introduced — by the fault-injection cell.

### UNCOVERED (with reason)

- **Join-dialog accept with a role the schema accepts** — a genuine
  member/admin accept (second account) would exercise the success render;
  blocked by the single-identity constraint below.
- **Real cross-account `accept_invite`** — both instances share one cloud
  identity; joining one's own org is a no-op. The accept RPC wire shape
  (hash-only) is code-audited but not fired by a second member.
- **Minimized-window restore (cell D)** — could not set a truly-minimized
  starting state without accessibility control; the `show`/`set_focus`/
  `unminimize` calls ran on the forward path with **no** warning logged, so
  they succeeded, but a minimized→restored transition was not visually staged.
- **`RunEvent::Reopen` window recreate (cell E)** — not staged (needs closing
  the last window via UI).
- **Windows/Linux argv forwarding** — macOS host only; PR body also lists this
  as remaining release-bundle coverage.
- **Rendered wdio invite specs** — currently broken by audit finding 1 (they
  assert the `orgii://` prefix on the rendered link); not run.

Upgrade note: this PR persists no new durable state, so there is no
version-boundary migration cell. The compatibility surface (old-format links)
is covered by unit tests for `orgii://` + legacy HTTPS `?invite=` parsing.

## Post-fix verification (third pass, rebuilt from the remediated branch)

inst-1 rebuilt from `pr552-audit` after the rebase + fix commits (see the
audit report's Remediation section) and relaunched. One trap re-observed on
the way: `open` of the new bundle while the old instance still ran was
absorbed by the single-instance forward (the PR's own plugin) — all
`yorg.orgii` processes must be killed before relaunching a new build.

| Cell | Scenario                                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1   | Warm malformed deep links (`cloud/join`, `?invite=`, `cloud/nonsense?x=1`)                                                                  | **PASS** — three `Ignoring malformed ORG2 Cloud deep link` warns, **zero** new `Navigating to:` lines, UI stays on the normal workstation view (no error page)                                                                                                                                                                                                   |
| V2   | Cold start WITH the malformed URL (`open -a <bundle> orgii://cloud/nonsense?x=1`) — the exact resurrection scenario from the 09:33 incident | **PASS** — `Ignoring malformed initial ORG2 Cloud deep link` (×2, known double-mount), app boots to the normal UI; the restart loop is gone                                                                                                                                                                                                                      |
| V3   | UI create org + invite (`PR552 Fix Verify`)                                                                                                 | **PASS** — rendered link is `https://invite.org2.dev/#invite=<64hex>` (new org-controlled domain live in the UI)                                                                                                                                                                                                                                                 |
| V4   | Owner pastes their own invite link into the join dialog                                                                                     | **PASS** — friendly translated "Couldn't load cloud org details" (ZodError→`unexpected_response` containment), NOT the raw Zod dump. The live server predates migration 0018, so the use was still consumed server-side; after 0018 is applied the same action returns `ORG2_ALREADY_MEMBER` → "You're already a member of this organization." and burns nothing |

Server-side 0018 behavior was separately proven in a disposable Postgres 16
(baseline 0001 + 0018): owner/member self-accept refused with `used_count`
untouched; fresh accept and post-removal reactivation still consume;
re-paste idempotent.

## Cleanup

- Test org `PR552-Invite-Test` (`49634658…`) soft-deleted via `cloud_delete_org`;
  read-back confirms `deleted_at=2026-08-10T16:18:07Z`. Its one-use invite goes
  with it.
- UI-pass test org `PR552 UI Invite Test` (`aaf35493…`) soft-deleted the same
  way; read-back confirms `deleted_at=2026-08-10T16:50:58Z` (its used-up
  invite goes with it).
- Post-fix test org `PR552 Fix Verify` (`2fbffe1e…`) soft-deleted the same way;
  read-back confirms `deleted_at=2026-08-10T17:43:39Z`.
- No `cloud_sessions` were created by the test. Local auth tokens copied to the
  scratchpad (session-isolated tmp) for RPC; deleted at end of session, not
  persisted elsewhere.
