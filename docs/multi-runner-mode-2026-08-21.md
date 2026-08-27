# Multi-Runner Mode — Design (2026-08-21)

Launch **one prompt against N harnesses at once** from the Session launchpad, then compare
the results. Two runners on the same prompt is the common case ("does Codex do this better
than Claude Code?"); same harness on two models is the other ("Opus vs Sonnet on this bug").

Written as a design document on 2026-08-21 and implemented on 2026-08-22 — see the update
block below for where the build diverged from the sketch. The archival of the retired
SWE-bench Benchmark UI (see §0) freed the surface this feature lands on.

Grounded in:

- `src/features/SessionCreator/variants/ChatPanel/` — the launchpad composer
- `src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/` — the launch path
- `src/features/SessionCreator/variants/ChatPanel/SessionCreatorOrgMembersPanel.tsx` — the
  per-row `[agent pill] [model pill]` anatomy this feature reuses wholesale

> **Update (2026-08-22): implemented.** Steps 1–4 of §8 landed; §5's `Diff` /
> `Keep this one` did not. Where this document and the code disagree, the code is
> the contract. What changed during the build:
>
> - **The hero pill is gone in multi mode, not relabelled.** §3.3 sketched a
>   `⧉ 3 runners ▾` pill in the hero sentence. A pill with a chevron that opens
>   nothing is a lie, and the runner list directly below already _is_ the
>   expanded picker. Multi mode now replaces the whole middle slot — hero and
>   cards — with a plain heading plus the runner list.
> - **It is called "Parallel run", and it is its own launcher under More.** §3.1
>   put a `⧉ Compare runners` button next to `[GUI|TUI]`; an intermediate pass
>   made it a launchpad card. It is neither: `CHAT_PANEL_CREATE_TARGET.PARALLEL_RUN`
>   is an entry in the **More** dropdown beside Create project and Manage
>   agents, and selecting it renders the creator as the multi-runner launcher.
>   "Compare runners" named the payoff; "Parallel run" names what the button
>   actually does, and comparing is what you do with the result.
>   The **`‹`** before the heading goes back to the Session tab. The Session tab
>   is left completely untouched — same hero, same four cards, same composer.
> - **A runner never inherits the launcher's model.** The first build folded
>   each row's override over the global `AdvancedConfig`, so a row with no
>   model of its own displayed — and would have launched with — whatever the
>   Session launcher last used. Model catalogues are scoped _per harness_, so
>   that model may be one the row's harness cannot serve. `resolveRunnerConfig`
>   now builds a row's launch config from the row alone; no model means
>   `NO_MODEL`, full stop.
> - **Harness first, then model.** The model pill is withheld until a harness
>   is chosen rather than shown disabled — the harness is what scopes the model
>   list, so before one is picked there is no list to open and nothing truthful
>   to put in the pill. The blocker order follows the same sequence: which
>   harness → can that harness run here → which model. Asking for a model before
>   knowing the CLI is even installed wastes the choice.
> - **The list seeds itself and holds a floor of two.** A dedicated surface must
>   never be empty, so arriving seeds row ① from whatever the Session launcher
>   was pointed at plus an empty ②. Removal stops at two: one runner on a
>   Compare-runners surface is a permanently disabled send button with no
>   explanation, which is worse than an honestly greyed-out remove button.
>   `runners.length > 1` is therefore no longer "the mode" — the surface is —
>   and `isMultiRunnerActive` / `multiRunnerActiveAtom` were deleted.
> - **The runner row wraps; it does not shrink.** Truncating
>   "GPT 5.6 Sol · Extra High" to "GPT…" loses exactly what the row exists to
>   show, so a model group that no longer fits drops to its own line intact.
>   The blocker note moved to its own line for the same reason — wedged between
>   the two pills it had no width left and rendered as a bare warning triangle,
>   and on a narrow panel it pushed the remove button outside the card.
> - **`SelectorPill`'s icon slot got `leading-none`.** A caller's icon is
>   usually an inline `<svg>`, whose line box reserves descender space it never
>   draws into. The pill hides that span on hover and reveals an absolutely
>   positioned chevron, so the leftover line box shifted the content baseline a
>   sub-pixel each way — every pill icon in the app visibly shook on hover.
> - **Two CLI blockers, not one.** `cli_not_installed` and `cli_no_gui` are
>   separate: "install it" and "this CLI has no GUI mode, so it can never take a
>   fanned-out prompt" are different problems with different fixes.
> - **`stopped` is its own run state.** `toUnifiedStatus` folds `cancelled` into
>   `failed`; reporting a run the user stopped (because another runner had
>   clearly won) as a failure was wrong.
> - **No per-row `Retry`; the group has `Run again`.** A faithful retry needs the
>   full launch context — including pasted images — snapshotted on the group.
>   Persisting base64 images is unacceptable and dropping them silently is worse,
>   so `Run again` reseeds the _launcher_ with the group's prompt and runners
>   instead. The user then sees exactly what will run, can install the missing
>   CLI or swap a model first, and keeps the composer's normal attachment
>   controls. Per-row retry stays open (§9).
> - **The runner's model override reuses `OrgMemberRuntimeConfig`.** Rather than
>   define a structurally identical twin, the two conversion helpers moved out of
>   `SessionCreatorOrgMembersPanel` into
>   `src/features/SessionCreator/agentRuntimeConfig.ts`, shared by both surfaces.
> - **Multi-runner is opt-in per surface.** `enableMultiRunner` is set only by
>   the launchpad's `renderSessionLauncher`. The runner list is global state, so
>   without that gate the embedded work-item and project creators would have
>   fanned out a "create with AI" click into N sessions.
> - **The group gets its own pre-flight, not `useSessionValidation`.** The first
>   build reused the single-launch validator; that was wrong. It validates the
>   _global_ creator selection — provider, account, `cliAgentType`, market-key
>   rules — and in multi mode those belong to each row, not to the launcher. A
>   correctly configured group would have been rejected because the launcher's
>   own (now hidden) single selection was empty, or happened to be Cursor IDE.
>   `validateMultiRunnerLaunch` checks what is genuinely group-wide — prompt and
>   repo — and `resolveRunnerBlocker` covers the rest per row. The composer's
>   `canLaunch` gate was split the same way. The repo is now required
>   unconditionally in multi mode: there is nothing to cut a worktree from
>   without one.

---

## 0. Prerequisite: the Benchmark runner is gone

The archived `BenchmarkRunBuilder` / `BenchmarkPanel` was the closest thing in-tree to a
fan-out launcher, but it solves the **transpose** of this problem: _N tasks × 1 agent config_.
Multi-runner is _1 task × N agent configs_. Its batch machinery (`benchmarkApi.startAgentBatch`,
`create_benchmark_master_session`, `BENCHMARK_AGENT_BATCHES`) is **not** reused — see §5 for why
the coordinator-session model is deliberately not repeated.

`src-tauri/src/benchmark/` stays live and untouched; nothing in this design calls it.

---

## 1. Scope

### Goals (v1)

1. Pick 2–6 **runners** in the launchpad, each an independent `(harness, model, effort, key source)`.
2. One prompt, one attachment set, one repo/branch → N background sessions launched together.
3. Each runner gets its **own git worktree and branch**, so they cannot corrupt each other.
4. A **run group** surface listing the N runs with live status, and one-click open into any of them.
5. Partial failure is normal and survivable: a runner that can't launch does not stop the others.

### Non-goals (v1)

- No cross-runner conversation. Runners never see each other's output; this is a race, not a team.
  (That is Agent Teams / `selectedAgentOrgId`, a different feature.)
- No automatic winner selection, scoring, or LLM-judge.
- No follow-up turns broadcast to all runners — once launched, each is an ordinary session.
- No TUI runners, no Cursor IDE runners (§7).
- No cost pre-estimate.

### Default decisions taken (flag if you want these changed)

| Decision                         | Default chosen                                                                                            | Alternative                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| How the mode is entered          | `⧉ Compare runners` toggle in the pinned-actions row; mode is **implied by count** (`runners.length > 1`) | An explicit `Single \| Multi` segmented pill                         |
| Middle of the launchpad          | Runner list **replaces** the four action cards while multi is on                                          | Keep cards, stack the list under them                                |
| Model picker in composer         | **Hidden** while multi is on — model lives per runner                                                     | Composer keeps a "group default" that rows inherit                   |
| Workspace isolation              | **Forced** `runningLocation = "worktree"`, locked, one branch per runner                                  | Allow `local` with a scary warning                                   |
| Max runners                      | **6**                                                                                                     | Unbounded                                                            |
| Exec mode (build/plan/read-only) | **Group-level**, one for all runners                                                                      | Per-runner axis                                                      |
| Grouping model                   | **Frontend-only** `runGroupId`; the N sessions are ordinary sessions                                      | Rust batch + synthetic master session (the archived benchmark model) |
| Duplicate harnesses              | **Allowed** — same harness, two models is the point                                                       | Dedupe by harness                                                    |
| Result surface                   | New chat-panel tab type `run-group`, compact list                                                         | N side-by-side chat columns                                          |
| Row feedback                     | The pill that owns the problem goes `danger` and carries the reason on hover                              | A separate warning line under the row                                |
| Partial failure                  | Per-row error, siblings continue                                                                          | Abort the whole group                                                |

---

## 2. Vocabulary

A **runner** is one row in the launcher. It is a complete, self-sufficient launch config:

```ts
interface Runner {
  id: string; // uuid; row identity, NOT the harness id
  dispatchCategory: DispatchCategory; // "cli_agent" | "rust_agent"
  cliAgentType?: CliAgentType; // when cli_agent
  agentDefinitionId?: string; // when rust_agent
  runtimeConfig?: OrgMemberRuntimeConfig; // model, effort, key source, account, tier
}
```

`runtimeConfig` is an **override**, not a full config: `AdvancedConfig` is derived globally
from `creatorDefaultModelSelectionAtom`, so a per-row choice has to fold over that global
base at read time (`applyAgentRuntimeConfig`). Agent Team member rows already had exactly
this problem, which is why both surfaces now share the shape and the two fold helpers
(`src/features/SessionCreator/agentRuntimeConfig.ts`).

A **run group** stores only what nothing else knows — which runner config produced which
session, and why a runner produced none:

```ts
interface RunGroup {
  id: string;
  prompt: string; // the one thing every entry shares
  createdAt: string;
  repoPath?: string;
  repoName?: string;
  baseBranch?: string;
  entries: Array<{
    ordinal: number; // 1-based launcher position
    outcome: "launched" | "failed" | "skipped";
    sessionId?: string; // when launched
    error?: string; // when failed
    blocker?: RunnerBlocker; // when skipped
    runner: Runner; // config snapshot
  }>;
}
```

Status, elapsed time and token counts are deliberately **absent**: those live on the session
records, and copying them here would create a second source of truth that goes stale on the
next session update. `resolveRunRowState` derives the row state from the live session
instead.

---

## 3. UI

### 3.1 Entry point

Multi-runner is a **create target** — **Parallel run** — selected from the **More** tab's
dropdown alongside Create project, Manage agents, GitHub issues and Add ORG:

```
        Session    Work Item    More  │  Parallel run ▾
                                ────
```

Arriving seeds the list: row ① mirrors whatever the Session launcher was pointed at, so
switching over never throws away a selection; row ② is deliberately empty — an empty row
asks "compare it against what?", where a duplicate would quietly run the same config twice.
The list will not drop below two rows; the remove button greys out at the floor.

The way back is a **`‹`** before the heading, which clears the rows and returns to the
**Session** tab. Leaving drops the runners on purpose: keeping them would silently re-open
a stale comparison next time, when the honest default is to re-seed from whatever the
launcher is pointed at then.

Because the surface owns the mode, there is no mode flag on the Session tab at all — it
renders exactly as it did before this feature existed.

### 3.2 Launchpad, single mode (today, unchanged)

```
                     Session    Work Item    More
                     ───────

           What do you want to build with  🦀 Claude Code ▾  ?

     ┌───────────┐ ┌────────────────┐ ┌─────────────┐ ┌──────────────┐
     │ Solve     │ │ Import         │ │ Add API     │ │ Show runtime │
     │ Work Item │ │ Session        │ │ key         │ │              │
     └───────────┘ └────────────────┘ └─────────────┘ └──────────────┘

  GUI TUI   ⋯
  ┌─────────────────────────────────────────────────────────────────┐
  │ <> ORGII    ⑂ develop    ▤ This Mac                              │
  │ Type a message, @ to add files, / to use skills                  │
  │ ＋      ✳ Fable 5 │ Extra High                        🎤     ↑    │
  └─────────────────────────────────────────────────────────────────┘
```

### 3.3 Launchpad, multi mode (proposed)

```
                     Session    Work Item    More
                     ───────

           What do you want to build with  ⧉ 3 runners ▾  ?

  ┌────────────────────────────────────────────────────────────────┐
  │ 🦀 Claude Code  ▾                  ✳ Opus 5 │ Extra High ▾    ✕ │
  │ ◇  Codex        ▾                  ✳ GPT-5.2 │ High      ▾    ✕ │
  │ ∞  Pick a harness ▾                                          ✕ │
  │ ───────────────────────────────────────────────────────────────│
  │ ＋ Add runner                        runs in parallel · 3 of 6 │
  └────────────────────────────────────────────────────────────────┘

  GUI TUI   │   + Work item    ⧉ Compare runners ●    ⋯
  ┌─────────────────────────────────────────────────────────────────┐
  │ <> ORGII    ⑂ develop    ⑂ Worktree per runner 🔒                │
  │ Type a message, @ to add files, / to use skills                  │
  │ ＋                                                    🎤     ↑³  │
  └─────────────────────────────────────────────────────────────────┘
```

Three deltas from single mode, all of them things you asked for:

1. **The four cards are gone.** The runner list occupies the middle slot
   (`launchpadSuggestionContent`, `SessionCreatorChatPanelView.tsx:333`). `Solve Work Item` does not
   vanish — it demotes to the compact `WorkItemAttachmentControl mode="add"` already used in the
   pinned row for non-launchpad layouts. `Import Session` / `Add API key` / `Show runtime` are
   utilities that also live under the **More** tab, so losing their cards costs nothing.
2. **No model picker in the composer.** `ControlButtons`' `ModelSelectorPill` is suppressed via the
   existing `hideModelSourcePill` prop — no new plumbing. Model is a runner property now, and having
   a second one in the composer would be a lie about which runner it applies to.
3. **The location pill locks to worktree.** `This Mac` becomes `Worktree per runner` with a lock
   affordance and a tooltip explaining why (§5.2).

The hero sentence keeps its shape — `What do you want to build with X ?` — with the harness pill
swapped for a count pill. Clicking it scrolls/focuses the list rather than opening a palette.

### 3.4 The runner row

Anatomy is lifted from `SessionCreatorOrgMembersPanel`'s member row
(`SessionCreatorOrgMembersPanel.tsx:322`), which is already exactly
`[name] ······ [agent SelectorPill] [model SelectorPill]`. Runners carry **no
ordinal badge**: they are a set, not a sequence — nothing about runner ② depends
on runner ① — and numbering them implied an order that does not exist. The
1-based `ordinal` survives in the data as the run-group entry key.

| Element                                                    | Component                                                                  | Opens                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Harness pill                                               | `SelectorPill` + `ModelIcon` / `resolveAgentIcon`, `Infinity` until picked | `DispatchCategoryPalette` (`hideOrgs`, human session excluded)                                                                |
| Model + effort pill — **absent until a harness is picked** | `ModelSelectorPill`                                                        | `UnifiedModelPalette` with `dispatchCategoryOverride` / `cliAgentTypeOverride`, so the list is scoped to _that row's_ harness |
| Remove                                                     | icon `Button`                                                              | —                                                                                                                             |

Using `ModelSelectorPill` rather than the org panel's plain `SelectorPill` is deliberate: it renders
the **model and effort segments** the composer shows today (`Fable 5 │ Extra High`), and effort is a
first-class comparison axis. `UnifiedModelPalette` already accepts per-row dispatch overrides, so
each row's model list is correctly scoped to that row's harness with zero new code.

Row-level states:

- **Unconfigured** — no model picked. Pill renders `danger`, launch is blocked with the row highlighted.
- **Unavailable** — CLI not installed / no key for that provider. Inline `⚠` plus the existing install
  affordance. The row is excluded from launch but kept in the list.
- **Duplicate** — same harness twice is legal; the row label disambiguates by model
  (`Claude Code · Opus 5` vs `Claude Code · Sonnet 5`).

### 3.5 The run group tab

A new `ChatPanelTabType` (`"run-group"`, `stationAccess: "always"`), opened on launch:

```
[ New session ]  [ ⧉ Fix the auth crash ×3 ]

 ⧉ Fix the auth crash · 3 runners · started 14:02        [Stop all]  ⋯
 “the login popup crashes on macOS when the OAuth window …”
 ────────────────────────────────────────────────────────────────────
 ①  🦀 Claude Code · Opus 5 · Extra High
     ● Running   2m14s   41k tok   agent/9f2c…            [Open] [Stop]
 ②  ◇  Codex · GPT-5.2 · High
     ✓ Done      1m48s   22k tok   agent/71ab…   +142 −18
                                          [Open] [Diff] [Keep this one]
 ③  ▲  Cursor CLI · Composer
     ✕ Launch failed · cursor-agent not found                  [Retry]
```

`Keep this one` = the merge/promote action on that runner's `agent/<session>` branch; `Diff` opens the
existing file-changes surface for that session. Both are cheap because the branch-per-runner
invariant (§5.2) makes "what did this runner actually do" a plain git question.

The N sessions also appear normally in the sidebar. **They are not hidden or re-parented** — the
archived benchmark's coordinator-session routing (master-row highlight, child hiding) was removed for
good reason and is not coming back. The group tab is the aggregate view; the sidebar stays flat.

---

## 4. State

Three additions, all frontend:

| Atom                        | Shape                                                                          | Persistence                                                            |
| --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `sessionCreatorRunnersAtom` | `Runner[]`                                                                     | `atomWithStorage`, alongside the existing draft                        |
| `runGroupsAtom`             | `Record<string, RunGroup>`                                                     | `atomWithStorage`, zod-validated (same pattern as `localChannelsAtom`) |
| —                           | run status is **derived**, read from the existing session store by `sessionId` | none                                                                   |

Deliberately **not** stored: per-run status, tokens, elapsed. Those are already live on the session
records; duplicating them into the group would create a second source of truth that drifts. The group
stores only the mapping `runnerId → sessionId` plus the launch-time config snapshot.

`runners.length > 1` is the single source of truth for "multi mode is on". No `isMultiRunnerAtom`.

---

## 5. Launch logic

### 5.1 Fan-out

The good news: the launch path is already pure enough. `resolveKeys(keySource, advancedConfig, cb)`
and `buildSessionLaunchPayload(options)` take **every** per-call input as a parameter — only the
`useSessionLaunch` hook reads the global creator atoms (`dispatchCategoryAtom`,
`selectedAgentDefinitionIdAtom`, `advancedConfig`, …). So a fan-out needs no refactor of either:

```
useMultiRunnerLaunch()
  ├─ validate once     : prompt non-empty, secret scan, short-input confirm, repo is a git repo
  ├─ prepare once      : prepareLaunchInput() → { agentInput, userInput }, imageDataUrls, adeContext
  ├─ create run group  : runGroupId, snapshot prompt + repo + branch + execMode
  └─ for each eligible runner (sequential await, ~150ms stagger):
        resolveKeys(runner.advancedConfig.keySource, runner.advancedConfig, …)
        buildSessionLaunchPayload({ …shared, …runner-specific, isBackgroundLaunch: true })
        sessionLaunch(params)  ──►  upsertSession(buildSessionFromLaunchResult(…))
                                    markTurnRunning(sessionId)
                                    injectSyntheticUserEventIfNeeded(…)
        record RunRef { runnerId, sessionId, status }
```

Every launch is `isBackgroundLaunch: true` (`SESSION_CREATOR_LAUNCH_MODE.START_BACKGROUND`), which is
already the mode the embedded creators use. Nobody gets navigated into a session; the group tab opens
instead. Sequential-with-stagger rather than `Promise.all` because these hit N different providers'
auth and rate limits, and a burst is the fastest way to get one of them 429'd.

The one-turn-per-session lifecycle is untouched: each launched session is an ordinary session that
happens to share a prompt with its siblings.

### 5.2 Isolation — the load-bearing decision

N agents editing one working tree concurrently corrupts all N results. This is not a warning-worthy
risk, it is a guaranteed failure, so multi mode **forces** `runningLocation = "worktree"`.

`getWorktreeFields` (`launchPayload.ts:181`) returns `{ isolate: true }` for a fresh isolated worktree,
and the Rust side's `create_session_worktree` runs `git worktree add -b agent/<session> <path> <base>`.
Because the branch is named **by session id**, N runners passing `isolate: true` automatically land on
N distinct worktrees and N distinct branches with no new backend work. That is the whole isolation
implementation: force one atom, reuse the existing per-session branch naming.

Consequences to surface in the UI:

- The location pill is locked and relabelled while multi is on.
- Non-git workspaces cannot isolate → multi mode is **unavailable**, with the reason stated (the same
  `showMissingGitAlert` path already renders this class of message).
- If the user had selected an _existing_ worktree path (`source.existingWorktreePath`), that selection
  would give all runners the same tree. Multi mode ignores it and always takes the fresh-isolate branch.

### 5.3 Failure semantics

Per-runner, not per-group:

| Failure                                   | Behaviour                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| No prompt, or no repo                     | Blocks the whole group — these are the only two group-wide requirements (`validateMultiRunnerLaunch`)                              |
| Model unset on a row                      | Row is ineligible; the group still launches if two other rows are ready                                                            |
| CLI not installed, or CLI has no GUI mode | Row excluded pre-flight; siblings launch; row shows `⚠` and why                                                                    |
| `resolveKeys` returns null (auth expired) | That row → `failed`, siblings continue, one session-expired toast total                                                            |
| `sessionLaunch` throws                    | That row → `failed` with the error text; `Run again` on the group tab reseeds the launcher so the run can be repaired and repeated |
| Every runner fails                        | Group tab still opens, showing N failures — never a silent no-op                                                                   |

Cancellation is per-row (`Stop`) plus a group-level `Stop all` that iterates the live sessions. No new
cancel plumbing: each is an ordinary session with an ordinary stop.

---

## 6. Reuse map

Almost nothing here is new UI. What the feature actually costs:

| Need                          | Existing thing                                                              | Verdict                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Harness picker per row        | `DispatchCategoryPalette` (+ `DispatchCategoryDropdown`)                    | reuse as-is, already takes per-invocation `current*` props                                         |
| Model + effort picker per row | `ModelSelectorPill` + `UnifiedModelPalette` with `dispatchCategoryOverride` | reuse as-is                                                                                        |
| Row layout                    | `SessionCreatorOrgMembersPanel` member row                                  | copy the anatomy; do **not** share the component (its data model is `OrgMember`, ours is `Runner`) |
| Hide composer model pill      | `ControlButtons` `hideModelSourcePill`                                      | already a prop                                                                                     |
| Middle-slot swap              | `launchpadSuggestionContent` in `SessionCreatorChatPanelView`               | one conditional                                                                                    |
| Pinned-row toggle button      | the `Team members` button pattern, same slot                                | copy                                                                                               |
| Worktree per runner           | `getWorktreeFields` + `create_session_worktree`                             | zero change                                                                                        |
| Fan-out launch                | `resolveKeys` + `buildSessionLaunchPayload` + `sessionLaunch`               | zero change; new hook composes them                                                                |
| Group tab                     | `chatPanelTabFactory` + a renderer + `CHAT_PANEL_TAB_STATION_ACCESS` entry  | new, small                                                                                         |

**Net new:** one atom pair, one `RunnerListPanel` component, one `useMultiRunnerLaunch` hook, one
tab type + renderer. No Rust changes.

---

## 7. Eligibility

| Dispatch category                 | Multi-runner | Why                                                                            |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `cli_agent` (29 CLIs)             | ✅           | The main case                                                                  |
| `rust_agent` (agent definitions)  | ✅           | Same launch path                                                               |
| `cursor_ide`                      | ❌           | Hands off to external Cursor; no managed session to compare                    |
| `human_session`                   | ❌           | Not an agent                                                                   |
| Agent Team (`selectedAgentOrgId`) | ❌ v1        | A team is already a fan-out; nesting one inside another needs its own thinking |

**TUI is excluded.** In TUI mode `useChatPanelLaunch` opens a terminal running the CLI's bare command
and never delivers the prompt programmatically — so "same prompt to N harnesses" is not something TUI
can honour. While multi is on, the `[GUI|TUI]` switch pins to GUI and disables TUI with a tooltip.

---

## 8. Build order

1. **State + row UI** — `Runner`, `sessionCreatorRunnersAtom`, `RunnerListPanel` with add/remove and
   both palettes wired. Renders in the middle slot; nothing launches yet.
2. **Composer integration** — pinned-row toggle, `hideModelSourcePill`, hero count pill, locked
   location pill, TUI pinning. Single mode provably unchanged (snapshot the existing launchpad tests).
3. **Fan-out** — `useMultiRunnerLaunch`, per-runner eligibility pre-flight, partial-failure handling.
   Verifiable without the group tab: launch 2 runners, confirm 2 sessions on 2 branches.
4. **Group tab** — `run-group` tab type, list renderer, live status from the session store, per-row
   Open/Stop/Retry.
5. **Compare actions** — `Diff` and `Keep this one` on top of the branch-per-runner invariant.

Steps 1–3 are the feature; 4–5 are the payoff. Each step is independently shippable.

---

## 9. Open questions

1. **Is exec mode really group-level?** "Plan with Codex, build with Claude Code" is a plausible use,
   but it makes the comparison apples-to-oranges. Defaulting to group-level; say the word to make it
   a per-row segment.
2. **Should the group be re-runnable?** A `Run again` on the group tab that re-fans the same prompt to
   the same runners is cheap to add and useful for flaky comparisons. Not in v1 as scoped.
3. **Side-by-side columns.** The list is the safe v1, but for 2–3 runners watching them race
   side-by-side is arguably the whole appeal. It is a real layout/perf project (N × `ChatHistory`),
   so it is deliberately v2 — worth confirming you agree with that sequencing.
4. **Max of 6.** Picked to keep worktree churn and provider burst sane, not from measurement.
