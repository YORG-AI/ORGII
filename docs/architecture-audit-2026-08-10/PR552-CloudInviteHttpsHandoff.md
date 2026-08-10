# PR 552 audit — org invites via HTTPS deep-link handoff

Audited head: `cc413d26e` (merge of develop into `junyu/deep-link-org-joining`),
diff vs `origin/develop` (merge-base `d26e2dd7d`), 7 files +197/−26.
Auditor worktree: `~/Projects/orgii-wt-pr552`. Live dual-instance results in
`PR552-dual-instance-live-test.md` (same folder).

## Verdict summary

| #   | Severity | Finding                                                                                                                                          | Status                                 |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| 1   | P1       | Rendered dual-instance E2E invite path breaks: spec asserts `orgii://cloud/join?invite=` prefix on the rendered link                             | fix required                           |
| 2   | P1       | Invite capability handoff rides a third-party-controlled origin (`atah2000.chatgpt.site`)                                                        | product decision needed before release |
| 3   | P2       | Handoff site enforces `/^[0-9a-f]{64}$/i` + lowercases; app web-link parser accepts any non-empty code — contract drift across repos             | recommend symmetric validation         |
| 4   | P2       | Join-dialog placeholder copy (13 locales) still says "paste orgii:// invite link or code"                                                        | copy sweep                             |
| 5   | P3       | Single-instance plugin now active in ALL builds; wdio primary shares `yorg.orgii` with the real app — suite must not run while the real app runs | document                               |
| 6   | P3       | `pathname.replace(/\/+$/, "/")` normalization only correct while the base path is `/`                                                            | nit                                    |
| 7   | P3       | Session share links stay `orgii://` while invites moved to HTTPS — asymmetric shareability                                                       | product note                           |

No blocking correctness defect found in the shipped code paths themselves; the
P1s are a test-surface regression and a trust-boundary decision.

## Findings

### 1. P1 — dual-instance E2E invite flow now fails (invisible to CI)

`tests/e2e/specs/core/cloud-dual-instance-ui.spec.mjs`:

- `createInviteFromOwner` (line ~691) waits until the rendered
  `cloud-org-invite-link` text `startsWith("orgii://cloud/join?invite=")` —
  after this PR the UI renders the HTTPS handoff link, so the waitUntil times
  out ("owner invite plaintext did not refresh").
- Line ~1242 hard-throws `rendered team invite is not a valid orgii join link`.
- Even with the prefix check fixed, the copied link is fed to
  `cloudSeedPendingInvite` (`src/app/root/e2e/helpers/cloud.ts:650`), which
  runs `parseCloudInviteDeepLink` only and rejects HTTPS links by design.

CI runs vitest only; the rendered wdio surface is exactly where the PR's own
audit doc says OS-dispatch coverage lives. Fix candidates: assert the new
`CLOUD_INVITE_WEB_BASE_URL#invite=` shape, derive the `orgii://` seed link via
the production `parseCloudInviteInput`, or extend the seed helper with an
explicit web-link arm (keeping the deep-link-parser-only arm for the handler
fidelity cell).

### 2. P1 — capability handoff through a third-party-controlled origin

`CLOUD_INVITE_WEB_BASE_URL = "https://orgii-invite-link.atah2000.chatgpt.site/"`
(`org2CloudOrgManagement.ts:70`). The invite capability lives in the URL
fragment, so it is never sent over HTTP — but the fragment IS readable by the
JavaScript served from that origin, and the origin is a personal subdomain
outside org2AI/yorgai control. Whoever controls (or later acquires) it can
harvest every invite capability at click time and join the org.

Deployed code inspected 2026-08-10 and currently clean:
`assets/InviteLauncher-*.js` parses fragment-first/query-fallback, validates
`/^[0-9a-f]{64}$/i`, then `window.location.assign("orgii://cloud/join?invite=…")`
after ~450 ms; the only `fetch` hits are image `fetchPriority` internals; no
beacon/analytics/websocket. But the app pins trust to the ORIGIN, not to this
code — tomorrow's deploy can differ. The URL is also hardcoded: rotating the
host requires an app release and kills every previously shared link.

Live re-confirmation 2026-08-10 (in-app Browser, real 64-hex fragment): the
page recognized the code ("Invite code ending in 8582") and rendered the
"Open ORG2 →" handoff; network capture shows the capability never leaves the
browser — only static assets plus **Cloudflare's own challenge-platform JSD**
(`/cdn-cgi/challenge-platform/.../jsd/oneshot/...`). So today no code exfil,
but the origin is both a personal subdomain AND Cloudflare-fronted (CF script
executes in-origin and can read the fragment) — two out-of-org trust surfaces.

Recommendation: before public release, host the page on an org-controlled
domain (e.g. the existing Vercel project) with the site source in an
org-reviewed repo. The PR body itself lists this as a risk; the audit's
position is that it should be a release blocker, not a footnote.

### 3. P2 — invite-code contract drift between site and app

Site: `/^[0-9a-f]{64}$/i` + `toLowerCase()` before building the deep link.
App `parseCloudInviteWebLink`: any non-empty `invite` value passes. Two
parsers of the same link now disagree: a future code-format change silently
breaks all handoff links (site renders "invalid"), while pasting the same
HTTPS link into the app dialog would still parse. Recommend the app validate
the same 64-hex invariant (defense in depth), or a comment pinning the site's
regex next to the code-generation invariant so format changes update both.

### 4. P2 — stale placeholder copy in 13 locales

`navigation.json` `inviteCodePlaceholder` ("貼上 orgii:// 邀請連結或邀請代碼"
etc.) predates the HTTPS link. Functionality is fine (`parseCloudInviteInput`
accepts HTTPS/orgii/raw), but the user pasting the link they actually received
is told it should look like `orgii://`. `importInputPlaceholder`
(session shares) is correctly still `orgii://` — do not sweep that one.

### 5. P3 — single-instance semantics now apply to every build

The plugin was previously commented out ("disabled for development"); it is now
unconditional for macOS/Windows/Linux. Verified identifiers: dev/prod
`yorg.orgii`, user instance-2 `yorg.orgii.instance2`
(`scripts/tauri/instance-profile.cjs:21`), wdio secondary
`yorg.orgii.e2e.instance2` (`tests/e2e/support/core/dualCloudHarness.mjs:162`)
— the dual harness and the dual-checkout workflow survive. But the wdio
PRIMARY keeps `yorg.orgii`: launching the suite while the real app is running
now forwards-and-exits instead of starting, which will look like a harness
timeout. Same for `pnpm tauri dev` alongside the running app.

### 6/7. P3 nits

- `parsed.pathname.replace(/\/+$/, "/")` collapses to `/` only because the
  expected path IS `/`; if the base URL ever gains a path segment,
  `/invite/` ≠ `/invite`. Normalize both sides.
- Session share links (`buildCloudSessionShareLink`) remain custom-scheme;
  invites are now the only HTTPS-shareable artifact. Deliberate scope cut per
  PR body; flagging for product consistency.

## 10-layer walk (architecture-audit)

| Layer                   | Verdict              | Evidence                                                                                                                                                                                          |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Compile/baseline      | Pass                 | worktree: 66/66 focused vitest, `tsc --noEmit` clean; CI clippy green                                                                                                                             |
| 2 Structural uniqueness | Pass                 | one builder (`buildCloudInviteLink`, sole caller `createCloudInvite`), one web parser, one native parser; `isCloudInviteDeepLink` only consumed by `parseCloudInviteDeepLink`                     |
| 3 Naming                | Pass w/ note         | code/comments consistent; stale copy is i18n (finding 4)                                                                                                                                          |
| 4 Type/domain           | Pass w/ note         | 64-hex invariant enforced at generation but not at web-link parse (finding 3)                                                                                                                     |
| 5 Branch/default        | Pass                 | `://` guard closes the raw-code fallthrough for foreign schemes (improvement over baseline); http→https origin mismatch rejects downgrade links                                                   |
| 6 Domain ownership      | Pass                 | Rust owns process/window lifecycle only; argv never parsed in Rust; routing stays in `useDeepLinkHandler`                                                                                         |
| 7 New-dev clarity       | Pass                 | comments explain fragment privacy + plugin order                                                                                                                                                  |
| 8 Wire/serialization    | Pass                 | only SHA-256 crosses RPC (unchanged); deployed handoff JS dumped and inspected — no exfil path today (finding 2 caveat: trust is origin-pinned)                                                   |
| 9 Init parity           | Pass (live-verified) | cold `getCurrent`, warm `onOpenUrl`, second-process argv forward, and `RunEvent::Reopen` window recovery converge on the same frontend owner; e2e enters via seeded atom (parity gap = finding 1) |
| 10 Data-shape alignment | Pass                 | app and site precedence identical (fragment-first, empty-fragment→query); site tolerates `#/invite=` prefix which the app never emits                                                             |

Live UI addendum (2026-08-10, screen access granted after the headless pass):
the Manage Org UI renders the HTTPS handoff link (finding 1's premise) and the
join dialog still shows the `orgii://` placeholder (finding 4) — both
live-confirmed. The join dialog accepts the HTTPS link end-to-end
(`parseCloudInviteInput` → `accept_invite` RPC), and rejects both a
wrong-host `orgii://collaboration/…` link and a foreign-origin
`https://evil.example.com/#invite=<64hex>` link client-side with the friendly
invalid-invite error (layer-5 origin guard verified live). Two pre-existing
(non-PR) defects surfaced during the pass — owner self-accept consumes the
invite use and returns `role:"owner"` which the client schema rejects as a
raw Zod dump, and malformed `orgii://cloud/*` links land on the 404
`<ErrorPage />` and re-trigger on every boot via the initial deep-link drain —
both root-caused in `PR552-dual-instance-live-test.md`.

## Remediation on this branch (2026-08-10, post-audit)

Branch `pr552-audit` was rebased onto develop `77330c736` and the findings
were fixed in place:

- **Finding 1 (P1, e2e)** — FIXED. Spec asserts the
  `https://invite.org2.dev/#invite=` shape; `cloudSeedPendingInvite` gained a
  production-parser web-link arm (`parseCloudInviteInput`), still rejecting
  raw codes. Rendered wdio run itself still requires a webdriver build.
- **Finding 2 (P1, third-party origin)** — FIXED.
  `CLOUD_INVITE_WEB_BASE_URL` now `https://invite.org2.dev/`; the handoff
  page source is org-reviewed in ORGII-cloud-infra `apps/invite-link/`
  (self-contained static page, CSP `default-src 'none'`, verified locally:
  missing/invalid/valid states, lowercase normalization, zero
  invite-carrying requests, and the built deep link routes into the live
  app's join dialog). Remaining ops step: create the Vercel project and
  bind `invite.org2.dev`.
- **Finding 3 (P2, contract drift)** — FIXED. The app's web-link parser now
  enforces the same `/^[0-9a-f]{64}$/i` + lowercase as the page
  (`CLOUD_INVITE_CODE_PATTERN`, pinned by comments on both sides).
- **Finding 4 (P2, placeholder copy)** — still open (13-locale copy sweep).
- **Findings 5–7 (P3)** — unchanged, documented.

Pre-existing defects from the live test, also fixed here:

- **Owner/member self-accept** — server migration 0018 (cloud-infra) makes
  `accept_invite` raise `ORG2_ALREADY_MEMBER` before consuming a use
  (verified in a disposable Postgres: refused self-accept burns nothing,
  reactivation still consumes); client maps the code to a translated
  message (13 locales) and wraps response-schema failures into a friendly
  error instead of the raw Zod dump.
- **Malformed `orgii://cloud/*` deep links** — now logged no-ops in both
  the warm listener and the initial drain (`isUnclaimedCloudDeepLink`);
  they no longer navigate to the 404 error page nor resurrect it on every
  boot via `getCurrent()`.

Rust specifics verified: `tauri-plugin-single-instance = 2.0.0 features
["deep-link"]` (Cargo.toml:540) locked at 2.4.2 (macOS-capable); plugin
registered FIRST in the builder chain as the deep-link forwarding contract
requires; window label `"main"` matches `tauri.conf.json`;
`recreate_main_window` (crates/app-window/src/lib.rs:275) is idempotent and
rebuilds from the startup config; callback logs `argument_count` only.
