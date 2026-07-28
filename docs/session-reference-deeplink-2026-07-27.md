# Session references in issue trackers — in-app chip + jump

Branch `codex/session-mention-deeplink` off develop @ `7529cb6f6`.

Lets a reviewer paste an ORG2 Cloud session reference into a GitHub issue,
and gives teammates a one-click jump from that issue — rendered inside
ORG2 — into the session's replay. Outside the app the reference stays an
opaque string, and it is not a capability: only members of the owning org
can resolve it.

## The reference

`orgii://cloud/session/ref?v=1&org=<uuid>&owner=<uuid>&session=<id>`

Already shipped (`cloudSessionReference.ts`, produced by the Team Sessions
row menu's "Copy ID"); this branch adds nothing to the grammar. It carries
the full identity tuple because a `sourceSessionId` alone is not globally
unique, and it deliberately uses `/session/ref` rather than the
capability-bearing `/session?share=<token>` path.

## Why this is safe outside the app

Measured against GitHub's own renderer (`POST /markdown`, mode `gfm`) on
2026-07-27 — all three ways a person might write it come back inert:

| Input form           | GitHub output                                  |
| -------------------- | ---------------------------------------------- |
| bare `orgii://…`     | plain text, no `<a>`                           |
| `[label](orgii://…)` | `label` only — the `<a>` and href are stripped |
| `<orgii://…>`        | plain text, no `<a>`                           |

So a non-ORG2 reader sees an opaque id at most, and no reader can navigate
from github.com. Inside the app, membership is re-asserted server side by
every read RPC (`assert_org_member`); the client's admission gate exists so
the app can say "not your org" instead of silently showing an empty
section.

## What this branch adds

1. **`remarkCloudSessionReferences`** — rewrites each VALID bare reference
   in a markdown `text` node into a link node. Code spans and fences are
   different node types, so they stay literal; link-bearing parents are
   skipped, so the explicit-link and autolink forms are not double-wrapped.
   A hand-written mdast walk, because `unist-util-visit` is not a direct
   dependency under pnpm's strict layout.
2. **`markdownUrlTransform`** — mandatory, not optional: react-markdown
   v9's `defaultUrlTransform` rewrites any `orgii:` href to `""`. Exactly
   the references that validate pass through; every other URL keeps the
   default allowlist, including the capability-bearing share form.
   Scoped to `href`, because the transform runs over every url-bearing
   attribute and only the link path has a chip to intercept the result.
3. **`CloudSessionReferenceChip`** — the rendered chip, on the same
   `BasePill` shell as read-only chat pills. It labels itself with the
   session's real name when the viewer already holds it and falls back to
   generic wording otherwise (see "Producing a reference" below).
4. **`decideCloudReferenceAdmission`** — shared gate. An EMPTY roster means
   "unknown, let the server decide", so a reference clicked during the boot
   window is not wrongly refused.
5. **`autoReplay` on the reveal request** — an in-app chip opens the
   transcript; an OS deep link stays reveal-only, so an external click
   never starts a download on its own. The deep-link handler now shares the
   admission gate, which also closes its old silent-degradation gap.
6. **`decideCloudAutoReplay`** — consumes the reveal from the RAW atom.

## Producing a reference

Referencing a session was only possible from the Team Sessions rows,
which are other people's. The session you most often want a reviewer to
look at is your own, and those rows offered nothing.

A local row carries no org, and a reference names one. Inventing it
yields a link that resolves for nobody, and the mistake is invisible at
the moment of pasting — so `resolveSessionReferenceOrg` decides rather
than guesses:

1. the cloud org the sidebar is currently scoped to, when the session was
   published there — the ordinary case, and free of a prompt;
2. otherwise the single org it was published to;
3. otherwise it asks, because the session spans orgs and the scope picks
   none of them;
4. never published ⇒ no reference is offered at all.

On that rule:

- **Copy ID on My Sessions rows**, hidden entirely for an unpublished
  session rather than failing when clicked.
- **Drag a session row onto a text surface** (issue comment box, new
  issue body) to insert the reference at the caret. The sidebar already
  emitted a pill drag, but its payload is the local `session://` path,
  which means nothing to a reader — so the drop resolves a cloud
  reference or declines with a reason. Deliberately NOT wired to the work
  item description: that is a Tiptap editor which both edits and displays
  the text, so a reference dropped there would never render as a chip.
- **The chip shows the session's real name** when the viewer already has
  it — from the org listing a member has loaded, or from the local
  session when it is theirs. Nothing is fetched for the label, so a
  viewer without access still sees the generic wording. The earlier
  reasoning for a always-generic label held only for non-members; for a
  member the name was already in hand, and showing it leaks nothing that
  access does not already grant.

## The load-bearing subtlety

A cloud teammate row's local session id is `imported-session-<hash>`, never
the source session id the reveal request names. The connector's
active-session-gated projection of that request is therefore null for
exactly the member case this feature serves, and the request is never
cleared — it stays resident in the atom.

So the effect reads the RAW atom, and a resident request needs four
guards — each one closing a defect adversarial review confirmed:

- **consumed-request high-water mark, read from the store** at effect
  time rather than from a captured render value. Two sidebar connectors
  are mounted at once whenever the hover sidebar is open; both run this
  effect in the same commit, and captured values would let both act.
- **a TTL** (120s). A request that could never be served — the org
  switch fell back to personal scope, say — would otherwise sit until an
  unrelated switch to that org fired a replay nobody asked for.
- **one forced refresh before believing absence.** `state === "ready"`
  is not freshness: a revalidation deliberately keeps the previous rows
  and that state, and an org the viewer is not scoped to receives no
  realtime invalidations at all. Judging "not found" off a cached
  listing would reject exactly the newly-shared session a reference is
  most likely to point at.
- **a local-reveal branch.** `rows` is the unfiltered listing and
  includes the viewer's own current-device rows that every rendered path
  drops. Replaying one would mint an `imported-session-<hash>` read-only
  copy of a live writable session and hide the original from My
  Sessions; instead the local session is revealed.

The residency also helps: a chip clicked while the Team Sessions section is
unmounted still replays once the navigation mounts it.

## Known limitation

If the referenced row sits past the Team Sessions pagination window, the
session still opens correctly in the chat panel, but the sidebar row is not
force-scrolled into view — the existing force-include is gated on the
revealed session being active, which never holds for a teammate row. Fixing
that gating is a separate change to shared reveal machinery: because the
request is never cleared, making the force-include unconditional would pin
one row past the user's filters indefinitely.

## Verification

- 70 unit tests across the plugin, the url transform, the admission gate,
  the auto-replay decision, the org and title resolvers, the drop-target
  helpers, and a real-pipeline integration test that renders through
  react-markdown with remark-gfm.
- Full suite green (709 files, 6460 tests); tsc and eslint clean.
- Adversarial multi-lens review over the diff, every finding
  independently verified before acting. Six defects confirmed and fixed,
  the two most serious found only by measurement or by tracing real
  call sites: a quadratic candidate scan that froze the renderer for
  seconds on a minified paste (86x slower than the develop baseline on a
  64KB body), and the stale-listing false "not in this organization".
- GitHub inertness measured, not assumed (table above).

## On-device run, 2026-07-27

Build `13:15` (newer than the last source edit at `12:46` — the bundle
actually carried the code under test).

| Assertion                                | Result                                                                                                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chip renders in a real markdown surface  | pass — icon, localized label, short id                                                                                                                                                                                                              |
| Chip opens a TEAMMATE's session          | pass — org switched, tab opened, teammate's transcript rendered verbatim                                                                                                                                                                            |
| Chip on the viewer's OWN session         | pass — reveal-local, no imported duplicate                                                                                                                                                                                                          |
| OS deep link                             | pass — revealed the row, did NOT auto-replay                                                                                                                                                                                                        |
| Reference to a non-member org            | pass — refused, sidebar scope untouched                                                                                                                                                                                                             |
| Refused link not dedup-burned            | pass — no "Revealing" line logged, URL unmarked                                                                                                                                                                                                     |
| Cloud ledger before/after                | pass — only this conversation's own live session grew, plus the session the test created. Zero tombstones, zero access_mode downgrades, zero count drops, epoch constant                                                                            |
| Destructive-verb audit, all levels       | pass — 0 destructive actions                                                                                                                                                                                                                        |
| Watchdog / forced-idle / retry-exhausted | pass — 0                                                                                                                                                                                                                                            |
| WARN/ERROR triage                        | 8 lines, all explained: boot-window scope fallback and token 401, four realtime CHANNEL_ERRORs that recovered within 1s, and one non-fatal FileSearch prewarm for the teammate's own repo path (an expected consequence of replaying their session) |
| Resource curve                           | pass — 168% CPU during replay import decayed to 0.4-1.9% idle; RSS flat at 456MB                                                                                                                                                                    |

### The GitHub issue surface itself

Covered. A fixture issue carrying all six cases, opened in the app's
GitHub Issues panel:

| Case in the issue body        | Rendered                                                  |
| ----------------------------- | --------------------------------------------------------- |
| bare reference in prose       | chip                                                      |
| `[label](orgii://…)`          | chip                                                      |
| `<orgii://…>`                 | chip                                                      |
| reference to a non-member org | chip; clicking refused it, no navigation, no scope change |
| inside a code span            | literal text                                              |
| inside a fence                | literal text                                              |

Clicking case 1 switched the sidebar org to the reference's org and
revealed the row. The fixture issue was closed immediately after.

**Detour worth recording:** the panel first showed
`GitHubReAuthError: GitHub re-authorization required`, which is wrong — the
stored token was valid (HTTP 200 as `Neonforge98`, scopes
`read:user, repo, workflow`). The real cause was that the active workspace
pointed at a FORK (`VantaNode/ORG2`, `has_issues: false`), so there were no
issues to list. `GitHubReAuthRequired` is emitted both for a missing
credential and for a genuine 401, and the UI collapses every failure into
the re-auth wording. Filed separately; unrelated to this branch.

### Cross-account, instance 2

Run on the second install (`yorg.orgii.instance2`, its own data dir),
signed in as a DIFFERENT account that is a member of
`CU Vanta Shares 0721` and NOT a member of `ORG2 OSS`.

| Assertion                                             | Result                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Replays a teammate's session it does not own          | pass — transcript rendered                                                                                                                                                                                                                                         |
| Chip renders inside that replayed transcript          | pass                                                                                                                                                                                                                                                               |
| Clicking a reference to an org this account is NOT in | pass — refused, no navigation, no scope change                                                                                                                                                                                                                     |
| Ledger, both orgs                                     | pass — zero tombstones, zero downgrades, zero count drops. The only changes were the sharing level this run deliberately raised, and two sessions a teammate was actively pushing to the org instance 2 cannot see — which is itself evidence the refusal was real |
| Destructive verbs / watchdog                          | 0 / 0                                                                                                                                                                                                                                                              |
| Resources                                             | CPU 0.0%, RSS 155MB flat                                                                                                                                                                                                                                           |

The refusal case is the strong one: the target org holds 707 live
sessions, and the reference named a real session in it. Nothing surfaced.

**Instance-2 limitations hit along the way** (environment, not the
feature): that install has no GitHub connection and no model credential,
so neither the issue panel nor an agent echo could produce a chip there.
The chip was obtained instead by raising the source session's sharing to
full replay on the primary and letting instance 2 replay it — which also
exercised the sharing pipeline end to end. Separately, instance 2
registers `orgii-instance2://`, so `orgii://` deep links always reach the
primary; an instance-2 build cannot consume references from the OS. That
is a dev-build identity artifact, not a shipping concern.

### Producer side, on device

Build newer than the last source edit, verified before the run.

| Assertion                                 | Result                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Copy ID on a published session            | pass — sits between Cloud share and Pin                                           |
| Copy ID ABSENT on an unpublished one      | pass — the same menu goes straight to Pin                                         |
| What lands on the clipboard               | pass — org is the active scope, owner and session correct                         |
| Drag a row onto the issue comment box     | pass — the box highlights and the CLOUD reference is inserted, not the local path |
| Chip shows the real name                  | pass — see below                                                                  |
| Destructive verbs / watchdog / WARN·ERROR | 0 / 0 / 0                                                                         |
| Resources                                 | CPU 1.0-1.3%, RSS 359MB flat                                                      |

The gate was checked against ground truth rather than by eye: the local
push markers were decoded first, which showed the session that DID offer
Copy ID has a marker (so the item was right), and a session absent from
both orgs' cloud rows was then confirmed to have no such item.

Name resolution produced a side-by-side on one screen: a reference into
the ACTIVE org rendered as its real title, while a reference into an org
whose listing was not loaded rendered as the generic wording — the whole
design in one frame.

**One ledger change left partly unexplained.** The session being opened
and replayed throughout moved `events_epoch` 1 to 2 with `stored_bytes`
+14 and no change in event count. It is none of the hard failures (no
tombstone, no access_mode downgrade, no count drop), no `epoch rewrite`
line was logged, and no file added here touches the sync engine, so it
cannot originate in this work; the likely trigger is an ingest amendment
to an already-frozen event forcing a re-anchor. Recorded as the first
thread to pull if epoch churn reappears.

## Producing a reference, round two

The first round shipped a producer half that passed its own test and was
still unusable for the thing people actually do. Dragging a TEAMMATE's row
did nothing at all, because `dragPayload` was only ever set by the My
Sessions builder — and a teammate's session is exactly the one you want
reviewed. The verification had exercised only the path that could pass.

Four changes, and one defect they caused:

- **Team Sessions rows are draggable**, carrying the whole reference as
  their payload. Someone else's session has no local push marker, so
  there is no org to resolve — the row has to know it.
- **What gets inserted is a markdown link**, `[title](orgii://…)`, not a
  bare url. That is one of the forms the renderer turns into a chip, so
  the posted result is identical; only the draft is legible. A textarea
  cannot hold a pill, so the draft is text either way.
- **The drag ghost mirrors the row** — its icon, its title, the owner
  underneath — instead of a bare text chip.
- **The `@` menu lists the active org's team sessions** beside local
  ones, inserting the same reference text.

**The defect that only dragging could find.** Making teammate rows
draggable also let them land in the CHAT composer, whose own drop helper
turns a payload into a pill. That is the one path a reference must not
take: the pill machinery special-cases a bare local session id in three
places — icon lookup, serialization, and the agent context line — and a
reference url degrades silently in all three. The `@` work had carefully
avoided that path; opening the drag door put it back. Fixed by routing a
recognized reference to text in the shared drop helper too, so drag and
mention now insert identically.

### Why the `@` work looks the way it does

- **Not a pill.** For the reason above. The previously unused
  `insertMentionText` is the right primitive: it consumes the typed `@`
  query and inserts plain text.
- **Both insertion switches and the keyboard path.** `useAtMention`
  (ChatPanel) and `useComposerInput` (ProjectContentEditor,
  SessionCreator) are independent switches, and the Enter-to-select path
  hardcodes its type mapping while mouse-select derives it generically.
  Missing any one silently mis-tags the selection.
- **Never fetches.** The menu reads the already-cached listing atom, not
  `useCloudOrgRemoteSessions`, which auto-fetches — opening a menu must
  not put an RPC on the wire. The cost is real and accepted: an org whose
  listing was never loaded contributes no team candidates.

### Not reachable from the issue comment box

There is no `@` menu there — it is a plain textarea. For issues the
producer paths are Copy ID and drag. Giving a textarea a mention menu is a
separate change.

### On device, round two

| Assertion                            | Result                                          |
| ------------------------------------ | ----------------------------------------------- |
| Drag a TEAMMATE row                  | pass — previously inert                         |
| Drag ghost                           | pass — icon, title, owner                       |
| Inserted form                        | pass — `[title](orgii://…)`                     |
| `@` lists team sessions              | pass — with the reference as the row subtitle   |
| `@` insert matches drag              | pass — byte-identical form                      |
| Ledger                               | pass — zero tombstones, downgrades, count drops |
| Destructive verbs / watchdog / ERROR | 0 / 0 / 0                                       |
| Resources                            | CPU 0.3-0.5%, RSS ~305MB                        |
