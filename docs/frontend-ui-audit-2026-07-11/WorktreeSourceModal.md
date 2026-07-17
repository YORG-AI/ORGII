# Frontend UI Audit — WorktreeSourceModal

**File:** `src/features/SessionCreator/components/WorktreeSourceModal.tsx` (718 LOC)
**Date:** 2026-07-11
**Auditor:** worktree-source-selector broad-scope pass (refines prior worktree-source-wiring + PR→base-resolution passes)
**Scope note:** This file lives under `src/features/**`, which is **outside** the
`design-system-components.mdc` enforced scope (`src/modules|engines|scaffold`).
Verdicts therefore weigh DS coverage + local cluster consistency case-by-case, not a hard "must migrate".

> **Refine log (this pass):**
>
> - **Line numbers re-synced.** The file grew to 718 LOC; the prior report's citations
>   (SourceRow @164, inputs @427/505/540, tab @598, footer @660-681) were stale. All rows below use current line numbers.
> - **DS target corrected.** Prior report suggested the 3 raw inputs → `SearchInput`/`Input`.
>   On inspection `SearchInput` (`src/components/SearchInput`) is a **heavyweight editor find widget**
>   (case/regex/whole-word toggles + prev/next nav arrows) — wrong fit for a plain form field.
>   The correct DS target for **all three** inputs is `Input` (`src/components/Input`), which supports
>   `prefix` (leading icon), controlled `value`/`onChange`, `type="search"`, `allowClear`, and `error`/`errorMessage`.
>   The sweep candidate is re-pointed accordingly.
> - **New a11y findings added** (broader-scope pass): missing `role="alert"` on the two async error
>   surfaces (GitHub list error + PR-resolve error), and missing WAI-ARIA tab semantics on the tab strip.
> - **New positive keep documented:** modal-level a11y (Escape / focus-trap / `aria-modal`) is provided by
>   DS `Modal` (`src/scaffold/ModalSystem`), so SourceRow/tab keyboard reachability + Escape-close are covered — do not re-flag.
>
> **Fix log — landed 2026-07-11 (follow-up PR, branch `junyu/fix-chat-tab-session-activation`):**
> All 5 fix-candidates below are now **fixed** in source. Line numbers in the tables are the
> pre-fix citations; the fixes shifted them (Input import + id constants added near the top).
>
> - **3 raw inputs → DS `Input`** (search / branch / name): migrated with `prefix` icon, controlled
>   `value` + string `onChange`, search uses `type="search"` + `allowClear`. Removed the
>   `relative` wrapper + absolute-positioned icons; DS `Input` renders the leading icon via `prefix`.
> - **Search accessible name:** `aria-label={t("creator.worktreeSource.githubSearchAria", …)}` added.
> - **Branch / name label association:** stable `id` (`worktree-source-branch-input` /
>   `worktree-source-name-input`) on each `Input`, `htmlFor` on the visible `<label>` — clicking the
>   label now focuses the field and SR associates them (chosen over `aria-label` to keep the visible label).
> - **Two async error surfaces:** `role="alert"` + `aria-live="assertive"` on the GitHub-list error
>   `div` and the PR-resolve error `span`. Visual tokens (`text-danger-6`, `text-text-3`) unchanged.
> - **Tab strip ARIA:** `role="tablist"` on the strip, `role="tab"` + `id` + `aria-selected` +
>   `aria-controls` on each tab button, `role="tabpanel"` + `id` + `aria-labelledby` on the body.
>
> **Input API alignment / accepted visual deltas** (DS `Input` spec takes precedence over the old ad-hoc classes):
>
> - Inner surface: DS `Input` uses `bg-bg-2` + `rounded-lg`; old inputs used `bg-bg-1` + `rounded-md`. Minor.
> - Font size: DS `Input` default size is 14px; old inputs were `text-[13px]`. Deferred to the DS spec
>   (per the migration brief: "if it conflicts with `Input`, defer to `Input`'s spec and document").
> - Focus ring: DS `Input` shows `primary-6` border + a 2px focus ring; old code used `focus:border-primary-5`
>   with no ring. This is the DS-standard focus affordance — accepted.
> - No capability gap hit: `prefix`, controlled `value`/string `onChange`, `type="search"`, `allowClear`,
>   `id` pass-through all exist on DS `Input`. Nothing had to be kept-with-reason for missing API.

## Branch-tab rework (2026-07-11 follow-up — searchable real-branch picker)

**Change:** the Branch tab was a single free-text `Input` that accepted _any_ string
as a base ref (`branchSource` from `branchInput`), so a non-existent name confirmed
and only failed later at `git worktree add`. It is now a **searchable list of real
branches** (local + remote) fetched via `gitApi.getGitBranches` — the same data source
`BranchPalette`/`useBranchFetch` use (`useBranchFetch.ts:203`). Pure mapping/filter/
custom-ref logic extracted to `worktreeBranchSource.ts` (unit-tested).

**Reuse note:** reused the **data source** (`getGitBranches`, `@src/api/http/git`), not
the `BranchPalette` component — the palette is a spotlight/dropdown shell (`SpotlightShell`,
checkout/create/delete modes, jotai cache) that does not embed in a modal tab. The modal
follows the local GitHub-tab pattern (search `Input` + fixed-height 6-state list + `SourceRow`),
which keeps the four tabs visually consistent.

| Line (new)                                                                                                                     | Element                                             | Verdict              | Reason                                                                                                                                                                                                  | Suggested change                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Branch search `Input` (`type="search"`, `allowClear`, `prefix={<Search/>}`, string `onChange`, `id`+`<label htmlFor>`)         | DS `Input`                                          | keep (DS)            | Matches the GitHub-tab `Input` migration exactly (same props/aria). Visible "Base branch or ref" `<label>` associated via `BRANCH_SEARCH_INPUT_ID`. No raw HTML.                                        | —                                                                     |
| Branch/custom-ref list rows                                                                                                    | `SourceRow` (existing local `<button>` abstraction) | keep with reason     | Same two-line 44px row used by every other tab; DS `DropdownItem` is a fixed 32px single-line `div[role=option]` and does not cover title+detail+trailing-check. Reused, not duplicated.                | Sweep candidate only if a 2-line option row appears in ≥2 more files. |
| Custom-ref row (`Hash` icon + "Use \"…\" as ref" + hint)                                                                       | `SourceRow`                                         | keep (good practice) | Preserves the tag/sha/any-ref escape hatch and is visually distinguished from real branches by the `Hash` (vs `GitBranch`) icon + hint detail. No new raw HTML.                                         | —                                                                     |
| Fixed-height list container `min-h-0 flex-1 ${DROPDOWN_PANEL.optionsMaxHeightClass} overflow-y-auto … border-border-2 bg-bg-2` | list wrapper                                        | keep (good practice) | Identical token-backed `max-h` cap + internal scroll as the GitHub tab → modal height stays stable as branch count grows.                                                                               | —                                                                     |
| `h-[180px]` loading/empty/error/no-match placeholders                                                                          | state containers                                    | keep with reason     | Same height-stable pattern as the GitHub tab's six-state list (documented in D3 below). Under the `max-h` cap so states don't collapse the modal.                                                       | —                                                                     |
| `min-h-[250px]` on the Branch tab root                                                                                         | layout                                              | keep with reason     | Same tab-height stabilizer as the other tabs (D3).                                                                                                                                                      | —                                                                     |
| Branch list error `<div role="alert" aria-live="assertive">`                                                                   | a11y                                                | keep (good practice) | Mirrors the GitHub-list error a11y fix; async fetch failure is announced.                                                                                                                               | —                                                                     |
| `worktreeBranchSource.ts` (pure helper)                                                                                        | pure TS (no JSX)                                    | keep                 | `toBranchOptions`/`sortBranchOptions`/`filterBranchOptions`/`shouldOfferCustomRef`/`branchToLaunchSource`/`customRefToLaunchSource` + shared `compactText` — unit-tested logic. Not a UI-audit surface. | —                                                                     |

**No new raw interactive HTML introduced** beyond the already-documented `SourceRow`
`<button>` (kept-with-reason) — the search field is DS `Input`, list rows reuse `SourceRow`.

## Branch-tab alignment (2026-07-11 follow-up — match the Spotlight branch selector)

**Change:** the Branch tab previously listed branches as flat rows with a **text
subtitle** ("Local branch" / "Remote branch"). It is now aligned with the existing
mature "Switch Session Branch" selector (`BranchPalette` / `BranchDropdown`,
`src/scaffold/GlobalSpotlight/palettes/BranchPalette/`):

- **Text subtitles removed.** Rows are single-line; type is conveyed by **icon**
  (worktree → `GitFork`, remote/origin → `Cloud`, local → `GitBranch`).
- **RECENT / WORKTREES / Other Branches sections** rendered with
  `DROPDOWN_CLASSES.sectionLabel` — the same section-label token + the same
  bucketing (`categorizeBranches`) the Spotlight selector uses.
- **Right-aligned relative timestamp** ("Yesterday" / "4 hr ago" / "2 days ago")
  via the shared `formatRelativeTime(..., "short")` formatter (`SourceRow.meta`).
- **Custom-ref escape hatch preserved** (tag / commit / any ref via the top
  "Use \"…\" as ref" row); generated `WorktreeLaunchSource` shape unchanged
  (`kind:"branch"`, `baseBranch` = resolvable ref, `sourceRef:"branch:<ref>"`).
  Worktree-section rows select their branch ref like any other branch.

**Reuse note:** reused the Spotlight selector's **data + logic**, not its UI shell —
`categorizeBranches` (`src/scaffold/GlobalSpotlight/utils/branchUtils.ts`),
`useWorktreeMap` (`…/BranchPalette/useWorktreeMap.ts`, branch→worktree-path map from
`getGitWorktrees`), and `formatRelativeTime` (`src/util/time/formatRelativeTime.ts`).
`getGitBranches` already returns `last_commit_date` per branch (so timestamps needed
no extra fetch). Pure grouping + timestamp adapters live in `worktreeBranchSource.ts`
(`groupBranchOptions` / `formatBranchTimestamp`), unit-tested.

| Line (new)                                                             | Element                         | Verdict              | Reason                                                                                                                                                                                                                                                    | Suggested change                                                |
| ---------------------------------------------------------------------- | ------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Branch rows (icon + name + right timestamp, no subtitle)               | `SourceRow` (`meta` prop added) | keep with reason     | Same two-line-capable 44px `SourceRow` as every other tab; now icon-first + trailing `meta` timestamp to mirror the Spotlight selector. DS `DropdownItem` is a fixed 32px single-line `div[role=option]` with no right-meta slot. Reused, not duplicated. | Sweep only if a right-meta option row appears in ≥2 more files. |
| Section headers (`RECENT` / `WORKTREES` / `Other Branches`)            | `DROPDOWN_CLASSES.sectionLabel` | keep (good practice) | Token-backed section label reused verbatim from the Spotlight selector / `BranchDropdown`; not raw ad-hoc styling.                                                                                                                                        | —                                                               |
| `branchRowIcon()` (`GitFork` / `Cloud` / `GitBranch`)                  | icon mapping                    | keep (good practice) | Icon-based type differentiation replaces the removed text subtitle; lucide icons already used across the modal.                                                                                                                                           | —                                                               |
| Right timestamp `<span className="tabular-nums …">` inside `SourceRow` | non-interactive meta text       | keep (good practice) | `tabular-nums` keeps relative times aligned; token colors (`text-text-3`). No raw interactive HTML.                                                                                                                                                       | —                                                               |
| `groupBranchOptions` / `formatBranchTimestamp` (pure helpers)          | pure TS (no JSX)                | keep                 | Reuse `categorizeBranches` + `formatRelativeTime`; unit-tested (grouping buckets, worktree merge, empty, timestamp styles). Not a UI-audit surface.                                                                                                       | —                                                               |

**Superseded:** the prior Branch-tab-rework rows citing the "Local branch" / "Remote
branch" `detail` subtitle no longer describe the shipped UI — subtitles were removed in
favour of icons + section grouping + right timestamps.

## Smart-tab rework (2026-07-11 follow-up — unified smart input)

**Change:** the Smart tab was two hardcoded static rows (`createSmartSources()` →
`Smart: <branch>` / `Smart: <repo>`) with no real intelligence. It is now a **single
unified smart input** (inspired by orca's smart page): one DS `Input` whose typed value
is classified (empty / `#123` / `owner/repo#123` / GitHub·GitLab PR·MR URL / branch·ref /
free text) and turned into a **mixed suggestion list** (PR / issue / branch / custom-ref /
name), each row iconed by kind. Pure classification + suggestion-merge logic lives in
`worktreeSmartInput.ts` (25 unit tests). `createSmartSources` + the modal's local
`slugFragment` were deleted (dead code); the two smart default rows are preserved verbatim
(`smart:current` / `smart:repo`) as the empty-query suggestions.

**Reuse note:** reused the **PR data + resolve flow** (`listOpenPRsLocal`/`listIssuesLocal`
via the existing GitHub `useEffect`, `resolvePrWorktreeBase` + `isPrSource`/
`prNumberFromSourceRef`/`mergeResolvedPrBase`), the **branch data** (`getGitBranches` via the
existing Branch `useEffect`, `branchToLaunchSource`/`customRefToLaunchSource`/
`filterBranchOptions`/`shouldOfferCustomRef`), the **name builder** (new shared
`nameToLaunchSource`, now used by both Smart and Name tabs — removes the duplicated inline
slug logic), `SourceRow`, DS `Input`, and the six-state fixed-height + `max-h`/`min-h-[250px]`
list pattern. No second fetch: the smart builder consumes the already-loaded `githubItems` +
`branchOptions`. The confirm flow is **not duplicated** — smart PR suggestions carry the same
`pr:<n>` sourceRef + resolve meta, merged into `prMetaBySourceRef`, so the existing confirm
handler resolves them identically to the GitHub tab.

| Line (new)                                                                                                                             | Element          | Verdict              | Reason                                                                                                                                                                                                                                            | Suggested change                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Smart unified `Input` (`type="search"`, `allowClear`, `prefix={<Sparkles/>}`, string `onChange`, `id`+`<label htmlFor>`, `aria-label`) | DS `Input`       | keep (DS)            | Same DS `Input` migration as GitHub/Branch tabs; visible "Name, number, branch, or URL" label associated via `SMART_INPUT_ID`. No raw HTML.                                                                                                       | —                                                                     |
| Mixed-suggestion list rows (PR / issue / branch / custom-ref / name)                                                                   | `SourceRow`      | keep with reason     | Same two-line 44px row abstraction as every other tab; DS `DropdownItem` is a fixed 32px single-line `div[role=option]` and does not cover title+detail+trailing-check. Icon varies by suggestion kind via `smartIcon()`. Reused, not duplicated. | Sweep candidate only if a 2-line option row appears in ≥2 more files. |
| Fixed-height list container `min-h-0 flex-1 ${DROPDOWN_PANEL.optionsMaxHeightClass} overflow-y-auto … border-border-2 bg-bg-2`         | list wrapper     | keep (good practice) | Identical token-backed `max-h` cap + internal scroll as the GitHub/Branch tabs → modal height stays stable as the suggestion list grows.                                                                                                          | —                                                                     |
| `h-[180px]` loading / empty-or-error placeholders                                                                                      | state containers | keep with reason     | Same height-stable pattern as the other tabs' six-state lists (D3). Under the `max-h` cap.                                                                                                                                                        | —                                                                     |
| `min-h-[250px]` on the Smart tab root                                                                                                  | layout           | keep with reason     | Same tab-height stabilizer as the other tabs (D3).                                                                                                                                                                                                | —                                                                     |
| `smartIcon(kind)` (GitPullRequest / CircleDot / GitBranch / Hash / CaseSensitive / Sparkles)                                           | icon mapping     | keep (good practice) | Reuses the same lucide icons the other tabs already use per source kind; keeps mixed rows visually distinguishable.                                                                                                                               | —                                                                     |
| `worktreeSmartInput.ts` (pure helper)                                                                                                  | pure TS (no JSX) | keep                 | `parseSmartInput`/`buildSmartSuggestions`/`nameToLaunchSource`/`slugFragment` — unit-tested logic (25 cases). Not a UI-audit surface.                                                                                                             | —                                                                     |

**Honesty / limitation (documented, not faked):** a PR/MR reference is only offered as a
**resolvable** PR row when it targets **origin** (bare `#123`/digits, or `owner/repo#n` /
GitHub PR URL whose `owner/repo` matches the origin remote). Cross-repo GitHub refs, GitHub
PR URLs for another repo, and **all GitLab MR URLs** are parsed to a PR-like structure but
surfaced as a **named-worktree** suggestion (kind `name`, isolate from HEAD, no fabricated git
base) with the detail "Reference — base not resolvable here; creates a named worktree". This
respects the "don't fake a base" constraint — GitLab has no backend base-resolution path, so
we parse + label it but never invent a git ref.

**No new raw interactive HTML introduced** — the input is DS `Input`, rows reuse `SourceRow`.

## List-item visual unification (2026-07-11 follow-up — one wrapper, one row height)

**Change:** all four tabs already shared the `SourceRow` component, but the
surrounding presentation still drifted:

1. **Container drift.** Smart / GitHub / Branch each inlined the _same_ bordered
   scroll-container class string three separate times, while the **Name tab**
   rendered its single `SourceRow` **bare** (no border / `bg-bg-2` / `max-h`
   wrapper) → the Name result looked unlike every other tab's list.
2. **Row-height drift.** `SourceRow` used `min-h-[44px]`. Two-line rows
   (title + detail — GitHub / Smart / Name) grew to their natural ~52px, while
   single-line rows (Branch: title + right timestamp, no subtitle) sat at 44px
   → visibly uneven row heights across tabs.

**Fix (pure visual — no data/interaction change):**

- **`SOURCE_LIST_CLASS` constant + `SourceList` wrapper** extracted
  (`WorktreeSourceModal.tsx:180-193`). The three inlined container strings are
  replaced by `<SourceList>` (`renderSmartTab` ~L524, `renderGithubTab` ~L610,
  `renderBranchTab` ~L740) so the bordered `max-h`-capped scroll region is
  defined **once**.
- **Name tab now wraps its result row** in the same `<SourceList>` (+ inner
  `flex flex-col gap-0.5` column, matching the other tabs' row column), and its
  root gained `min-h-[250px]` so the `flex-1` list fills the panel identically
  (`WorktreeSourceModal.tsx:829,850-868`).
- **`SourceRow` `min-h-[44px]` → `min-h-[52px]`** (`WorktreeSourceModal.tsx:200`).
  52px is the _natural_ two-line height (py-2 16px + title `leading-5` 20px +
  detail `leading-4` 16px), so two-line rows are unchanged and single-line
  (Branch) rows are now floored to the same 52px and vertically centered via the
  existing `items-center` → **identical row height in every tab**.

| Line (new)         | Element                                                              | Verdict              | Reason                                                                                                                                                                                                                                                       | Suggested change |
| ------------------ | -------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 180-193            | `SOURCE_LIST_CLASS` + `SourceList` wrapper                           | keep (good practice) | Single source of truth for the bordered / `bg-bg-2` / `max-h-[200px]` / internal-scroll list region; removes 3 duplicated inline class strings and pulls the Name tab into the same shell. Presentational `div` wrapper, no interactive HTML.                | —                |
| 200                | `SourceRow` `min-h-[52px]` (was `min-h-[44px]`)                      | keep                 | 52px = the natural two-line row height, so single-line (Branch) rows now match two-line rows exactly. `items-center` centres shorter content. Standard touch-target-plus; no spacing-scale token maps to 52px.                                               | —                |
| ~524 / ~610 / ~740 | `<SourceList>` in Smart / GitHub / Branch tabs                       | keep (good practice) | Replaces the previously-inlined identical container string; behaviour (max-h cap + internal scroll → stable modal height) unchanged.                                                                                                                         | —                |
| 850-868            | Name tab result row wrapped in `<SourceList>` + `min-h-[250px]` root | keep (good practice) | Name result now renders in the same bordered list shell as the other tabs (previously bare); root `min-h-[250px]` matches the other tabs so the `flex-1` list fills identically. Conditional on `nameSource` (unchanged — empty input still renders no row). | —                |

**Superseded:** the D1 row citing `SourceRow` `min-h-[44px]` and the D3 row
`191 min-h-[44px]` now read `min-h-[52px]`; the "Fixed-height list container …"
keep rows in the Branch-tab and Smart-tab sections are now satisfied by the
shared `SourceList` wrapper rather than three inlined copies.

**No functional/interaction regression:** selection logic, fallback, PR resolve,
cache, custom-ref row, Branch section labels (`DROPDOWN_CLASSES.sectionLabel`,
kept **outside** `SourceRow` inside `SourceList`), and timestamp `meta` are all
untouched — only the wrapping container and row `min-h` changed. Verified by the
89-test scoped suite (`worktreeSourceCache` / `worktreeBranchSource` /
`worktreeSmartInput` / `worktreeSourceResolve` / `launchPayload`) + `pnpm typecheck` + file lint, all green.

## Cache / preload layer + refresh control + row unification (2026-07-12 follow-up)

**Re-audit trigger:** since the previous pass the modal grew a **data/cache layer**
(`useWorktreeSourceData` hook backed by `worktreeSourceCache.ts` pure helpers +
`worktreeSourceCacheAtom` jotai atom, reusing the app-wide `branchCacheAtom` for
branches), a **refresh control** inside the GitHub/Branch `Input` suffix, the
**`SourceRow` height migrated to DS `DROPDOWN_ITEM` tokens** (the earlier
`min-h-[52px]` arbitrary value is gone), and **Smart/GitHub rows are now single-line**
(their `detail` subtitle is no longer rendered, matching the Branch tab). Re-audited
the current file (`WorktreeSourceModal.tsx`, 967 LOC) against D1–D5.

### NEW — D1 / D4: `SourceRefreshSuffix` raw `<button>` inside DS `Input` suffix

| Line (new) | Element                                                                                                                                                                             | Verdict                    | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Suggested change                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 192-214    | `SourceRefreshSuffix` — raw `<button>` (icon-only `RefreshCw`, spins while `refreshing`) rendered via the DS `Input` `suffix` prop on the GitHub (613) + Branch (731) search inputs | **keep with reason** (NEW) | Icon-only action → DS routing table nominally points to `IconButton`, **but** this sits in the `Input` **`suffix`** slot (a tight inline flex box with a 6px left margin, `.input-suffix`), where `IconButton`'s own fixed hit-area + hover-fill + radius do not sit flush against the field. There is sibling precedent for a raw `<button>` in an `Input` `suffix` (`engines/ChatPanel/panels/WorkspaceExplorePanelView.tsx:318-327,352` — the search submit button). File is `src/features/**` (outside the enforced `modules\|engines\|scaffold` DS scope). a11y is satisfied (see D4). | Sweep candidate only if an "inline input-suffix icon action" recurs in ≥2 more files → then add a DS `InputAction`/small-ghost `IconButton` variant sized for the suffix slot. Not actionable as a one-off. |
| 202        | `aria-label={ariaLabel}` on the refresh `<button>` (i18n `refreshGithub` / `refreshBranches`) + `disabled` while loading + `stopPropagation`                                        | keep (good practice, NEW)  | Icon-only control carries an accessible name; `disabled` is threaded from `!repoPath \|\| state==="loading"`; the `RefreshCw` icon gets `animate-spin` only while `refreshing`. Passes D4.                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                           |

### CHANGED — D1: `SourceRow` height now DS-token-based

| Line (new) | Element                                                                                                                                                                                                         | Verdict          | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Suggested change                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 216-256    | `SourceRow` `<button>` — now uses `DROPDOWN_ITEM.minHeightClass` (`min-h-8` = 32px) + `.gapClass` / `.paddingXClass` / `.borderRadiusClass` / `.transitionClass` (was the ad-hoc `min-h-[52px]` two-line floor) | keep with reason | Still a two-line-capable selectable row with a trailing check; DS `DropdownItem` is a fixed 32px single-line `div[role=option]` and does not cover the optional detail line + trailing `meta` + trailing check. But the row now consumes the **DS dropdown-item tokens** for min-height / gap / padding / radius / transition instead of literals → less drift, and single-line rows floor at the standard 32px. `py-1` lets two-line variants (Name / custom-ref) grow naturally. Feature-scope file. | Same sweep note as before — promote to a `DropdownItem` two-line variant only if a 2-line option row appears in ≥2 more files. |

**Supersedes** the D1 SourceRow row (`min-h-[52px]`) and the D3 `200 min-h-[52px]`
row below — the height literal is replaced by `DROPDOWN_ITEM.minHeightClass`, so there
is **no remaining arbitrary `min-h-[…]` value on `SourceRow`**. The `min-h-[250px]`
tab-body stabilizer and `h-[180px]` state placeholders are unchanged (still D3
keep-with-reason).

### CHANGED — single-line Smart / GitHub rows (visual consistency)

| Line (new)                         | Element                                                                                                | Verdict              | Reason                                                                                                                                                                                                                                                                                                                                       | Suggested change |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 584-596 (Smart) / 670-682 (GitHub) | `SourceRow` rendered with `title` only — the previously-passed `detail` subtitle is no longer rendered | keep (good practice) | Smart + GitHub rows are now single-line, matching the Branch tab (icon + name + optional right `meta`). Removes the title/subtitle height variance across tabs. The Name tab + custom-ref row still pass `detail` intentionally (they show the resolved base / ref-type hint), which is the one place a subtitle carries non-redundant info. | —                |

**Observation (not a UI finding):** `SmartSuggestion.detail` is still computed in
`worktreeSmartInput.ts` but no longer consumed by the Smart-tab `SourceRow`. It is
retained as unit-tested data (asserted in `worktreeSmartInput.test.ts`) and is not a
rendered-UI surface, so it is out of scope for this skill (flag under `architecture-audit`
dead-data only if it is dropped from the tests too). The dead `SmartSuggestionKind`
`"smart"` member and the two synthetic `smart:current` / `smart:repo` default rows
noted in earlier passes are **confirmed removed** — the empty-query list now shows real
recent PRs + branches (`defaultSuggestions`), and the kind union is
`pr | issue | branch | name | customRef`.

### D2 / D3 re-sweep (current file)

- **D2:** still zero arbitrary `bg-[var(--…)]` / hex / rgb literals. All colors are
  tokens (`text-text-1/2/3`, `bg-bg-2`, `border-border-2`, `text-primary-6`,
  `text-danger-6`, `bg-surface-hover`, `bg-transparent`). The refresh button uses
  `text-text-3` → `hover:text-text-1` + `disabled:opacity-50` tokens. **No new fix.**
- **D3:** remaining pixel literals are `min-h-[250px]` (tab-body height stabilizer, ×5),
  `h-[180px]` (six-state placeholders), and `text-[12px]`/`text-[13px]` (repo dropdown
  typography convention) — all previously documented keep-with-reason. `SourceRow`'s
  former `min-h-[52px]` is **gone** (now `DROPDOWN_ITEM.minHeightClass`). The refresh
  button uses `DROPDOWN_SEARCH.iconSize` (token) for its glyph. **No new fix.**

### Cache/preload layer (data — not a UI-audit surface, documented for completeness)

| Symbol                                                   | Verdict | Reason                                                                                                                                                                                    |
| -------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useWorktreeSourceData` (`useWorktreeSourceData.ts`)     | keep    | Data hook: preload-on-open, stale-while-revalidate, per-repo TTL cache, in-flight de-dup, `refresh()`. No JSX / UI surface. Belongs to logic-test + `architecture-audit`, not this skill. |
| `worktreeSourceCache.ts` (pure helpers)                  | keep    | Framework-agnostic freshness / LRU / prune / in-flight registry — unit-tested (`worktreeSourceCache.test.ts`). No UI.                                                                     |
| `worktreeSourceCacheAtom.ts` (`worktreeGithubCacheAtom`) | keep    | jotai atom holding the GitHub cache map; branches reuse the app-wide `branchCacheAtom` (no duplicate cache). No UI.                                                                       |

## PR-scope additions (carried — PR→base resolution wiring)

| Line    | Element                                                              | Verdict                          | Reason                                                                                                                      | Suggested change                                                                     |
| ------- | -------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 663-679 | Footer confirm `Button` with `loading={isResolving}` + dynamic label | keep (DS)                        | Uses DS `Button`'s built-in `loading` spinner + disabled; no raw HTML. Network-fetch loading UX handled here.               | —                                                                                    |
| 651-653 | `<span>` inline resolve error (`text-danger-6`)                      | **fixed** (a11y) / keep (visual) | Non-interactive status text on a named token; visually correct. Now announced to SR.                                        | **Done:** added `role="alert"` + `aria-live="assertive"`; `text-danger-6` untouched. |
| —       | `worktreeSourceResolve.ts` (pure helper)                             | keep                             | Pure TS (no JSX); `isPrSource`/`prNumberFromSourceRef`/`mergeResolvedPrBase` are unit-tested logic. Not a UI-audit surface. | —                                                                                    |

## D1 — Raw HTML vs Design System

| Line    | Element                                                                                             | Verdict                                                             | Reason                                                                                                                                                                                                                                                                                                                                                                                                            | Suggested change                                                                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 188     | `<button>` `SourceRow` (icon + two-line title/detail + trailing check, `min-h-[52px]` — was `44px`) | keep with reason                                                    | DS `DropdownItem` is a fixed 32px **single-line** `div[role=option]`; it does not cover a 52px **two-line** (title + detail) row with a trailing check. `SourceRow` is the local abstraction (5 call sites, one definition), now wrapped in the shared `SourceList` in every tab. Feature-scope file. `min-h` bumped 44→52 so single-line (Branch) rows match two-line rows (see "List-item visual unification"). | Sweep candidate only if a two-line option row appears in ≥2 more files → then add a `DropdownItem` two-line variant. Not actionable now.                                                                                                           |
| 495-502 | `<input>` GitHub search (leading `Search` icon, token border)                                       | **fixed** (migrated)                                                | Migrated as a group with 576/611 (sweep landed).                                                                                                                                                                                                                                                                                                                                                                  | **Done:** DS `Input` with `prefix={<Search/>}`, `type="search"`, `allowClear`, `aria-label`. Removed relative wrapper + absolute icon.                                                                                                             |
| 576-581 | `<input>` branch/ref (leading `GitBranch` icon)                                                     | **fixed** (migrated)                                                | Same sweep.                                                                                                                                                                                                                                                                                                                                                                                                       | **Done:** DS `Input` with `prefix={<GitBranch/>}`, `id` + `<label htmlFor>` association.                                                                                                                                                           |
| 611-618 | `<input>` worktree name (leading `CaseSensitive` icon)                                              | **fixed** (migrated)                                                | Same sweep.                                                                                                                                                                                                                                                                                                                                                                                                       | **Done:** DS `Input` with `prefix={<CaseSensitive/>}`, `id` + `<label htmlFor>` association.                                                                                                                                                       |
| 686-702 | `<button>` tab pill (underline tab strip, `border-b-2` active)                                      | keep with reason (raw button retained) / **fixed** (a11y semantics) | Custom **full-underline** active indicator; DS `TabPill variant="simple"` renders a small **dot** marker (not a full underline) and would change the visual. Feature-scope; not a like-for-like swap, so the raw `<button>` stays. But the tab pattern now carries WAI-ARIA semantics.                                                                                                                            | Raw button kept (visual parity). **Done (a11y):** `role="tablist"` on strip, `role="tab"`+`id`+`aria-selected`+`aria-controls` per button, `role="tabpanel"`+`aria-labelledby` on the body. DS underline `TabPill` variant remains a future sweep. |

Footer Confirm / Cancel already use DS `Button` — no finding.

> **Superseded (2026-07-11 Branch-tab rework):** the row at 576-581 (single branch/ref
> `Input`) no longer describes the shipped UI — the Branch tab is now a searchable
> **list** backed by `getGitBranches` (see the "Branch-tab rework" section at the top).
> The field there is a DS `Input type="search"` and the branch/custom-ref rows are
> `SourceRow`. The historical verdict (DS `Input`, keep) still holds for the search field.

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value  | Verdict | Reason                                                                                                                                                                                                                              | Suggested change |
| ---- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | (none) | —       | Colors/surfaces are all tokens (`text-text-1/2/3`, `bg-bg-1/2`, `border-border-2`, `text-primary-6`, `text-danger-6`, `focus:border-primary-5`, `bg-surface-hover`). No `bg-[var(--…)]`, hex, or rgb literals anywhere in the file. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                | Value                                                      | Verdict              | Reason                                                                                                                                                                                   | Suggested change                                                                |
| ----------------------------------- | ---------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 200                                 | `min-h-[52px]` (SourceRow — was `44px`)                    | keep                 | Bumped to the natural two-line row height so single-line (Branch) rows match two-line rows across all tabs; `items-center` centres shorter content. No spacing-scale token maps to 52px. | —                                                                               |
| 201,205,501,515,524,532,580,617,694 | `text-[13px]` / `text-[12px]`                              | keep                 | Matches repo dropdown convention — DS `DROPDOWN_ITEM.fontSizeClass`/`DROPDOWN_SEARCH.fontSizeClass` are themselves `text-[13px]`. Consistent, not ad-hoc.                                | — (part of the repo-wide typography-scale sweep, not this component's concern). |
| 488,706                             | `min-h-[250px]` (tab body min-height)                      | keep with reason     | Deliberately stabilizes modal height across the 4 tabs so switching tabs doesn't cause the modal to jump. No token for modal-body min-height.                                            | —                                                                               |
| 509,515,524,532                     | `h-[180px]` (loading/error/empty/no-match placeholders)    | keep with reason     | Fixed height keeps the six list states from collapsing; sits under the `max-h-[200px]` cap so the list height stays stable across state transitions.                                     | —                                                                               |
| 506                                 | `max-h-[200px]` via `DROPDOWN_PANEL.optionsMaxHeightClass` | keep (good practice) | Token-backed cap (not a raw arbitrary value) — this was the prior PR's fix; the GitHub list scrolls internally instead of growing the modal with PR count.                               | —                                                                               |

## D4 — Accessibility

| Line              | Element                                 | Verdict                             | Reason                                                                                                                                                                                                             | Suggested change                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —                 | Modal container (`Modal` / ModalSystem) | keep (good practice)                | DS `Modal` supplies `role="dialog"` + `aria-modal`, Escape-to-close, focus trap, and focus restore. So SourceRow/tab **keyboard reachability + Escape-close are already covered** by the wrapper — do not re-flag. | —                                                                                                                                                                                                                                                                    |
| 188               | `SourceRow <button>`                    | keep                                | Has visible text (title/detail) as accessible name; `type="button"`; native Enter/Space + focus inside the trap.                                                                                                   | —                                                                                                                                                                                                                                                                    |
| 686               | tab `<button>`                          | keep (name) / **fixed** (semantics) | Icon + visible label = accessible name, `type="button"`. The 4-button strip is now a proper **tab pattern**. **NEW → fixed.**                                                                                      | **Done:** `role="tablist"` on strip, `role="tab"`+`id`+`aria-selected`+`aria-controls` per button, `role="tabpanel"`+`id`+`aria-labelledby` on the body. (Roving-tabindex arrow-key nav not added — Tab still moves focus; acceptable for low-severity enhancement.) |
| 495-502           | GitHub search `<input>`                 | **fixed**                           | No `<label>` and no `aria-label` (placeholder is not an accessible name). **Carried → fixed.**                                                                                                                     | **Done:** `aria-label={t("creator.worktreeSource.githubSearchAria", …)}` on the DS `Input`.                                                                                                                                                                          |
| 565-569 / 600-604 | `<label>` for branch / name inputs      | **fixed**                           | Labels were visible text but not linked to their inputs.                                                                                                                                                           | **Done:** `id` on each DS `Input` + `htmlFor` on the `<label>` — click-to-focus + SR association now work.                                                                                                                                                           |
| 514-521           | GitHub list **error** state `<div>`     | **fixed** (a11y)                    | Async load failure was plain text with no `role="alert"`/`aria-live`. **NEW → fixed.**                                                                                                                             | **Done:** `role="alert"` + `aria-live="assertive"` on the error container.                                                                                                                                                                                           |
| 651-653           | PR-resolve **error** `<span>`           | **fixed** (a11y)                    | Async `worktree_resolve_pr_base` failure was shown only visually. **NEW → fixed.**                                                                                                                                 | **Done:** `role="alert"` + `aria-live="assertive"` on the span.                                                                                                                                                                                                      |

## D5 — Visual Patterns Observed

- **Two-line selectable option row** (icon + title + detail + trailing check): `SourceRow`, used 5× **within this one file** but from a single local definition — already abstracted locally. Not a cross-file ≥3 abstract candidate. Watch-list only.
- **Raw text `<input>` + leading icon + token border** (495 / 576 / 611): 3 occurrences **within this file** → **migrated to DS `Input`** (2026-07-11, sweep landed). No longer a debt.
- **Underline tab strip** (`border-b-2` active): single implementation here — ignore until a second underline-tab site appears.
- **Height-stable multi-state list** (`h-[180px]` placeholders under a `max-h-[200px]` cap): a good local pattern; keep.

## State coverage (six states — all present & height-stable)

| State                         | Rendered at                                   | Stable height?         |
| ----------------------------- | --------------------------------------------- | ---------------------- |
| loading                       | 508-512 (spinner)                             | ✅ `h-[180px]`         |
| error                         | 514-521                                       | ✅ `h-[180px]`         |
| empty                         | 523-529                                       | ✅ `h-[180px]`         |
| no-match (ready + 0 filtered) | 531-537                                       | ✅ `h-[180px]`         |
| resolving-PR                  | 667 / 672-675 (Button `loading` + label swap) | ✅ (footer)            |
| resolve-failed                | 651-653 (error span)                          | ✅ (footer, truncates) |

All six are individually visible and don't collapse the modal. Only gap: transient `githubState === "idle"` renders an empty list container before the effect flips to `loading` (open→effect is synchronous-ish, so practically invisible). Not worth a fix.

## Summary (updated after 2026-07-12 cache/preload + refresh re-audit)

- **2026-07-12 re-audit delta (this pass):**
  - **1 NEW keep-with-reason (D1):** `SourceRefreshSuffix` raw `<button>` inside the
    DS `Input` suffix — `IconButton` doesn't fit the inline suffix slot cleanly; sibling
    precedent + features-scope + a11y satisfied. Sweep candidate if the input-suffix icon
    action recurs ≥2 more times.
  - **1 NEW good-practice keep (D4):** refresh button `aria-label` + `disabled` + spin state.
  - **SourceRow height literal removed:** `min-h-[52px]` → `DROPDOWN_ITEM.minHeightClass`
    (DS token). No arbitrary `min-h-[…]` remains on `SourceRow`.
  - **Smart/GitHub rows now single-line** (detail subtitle dropped) → consistent with Branch.
  - **Confirmed dead code removed:** `SmartSuggestionKind "smart"` member + the two synthetic
    `smart:current` / `smart:repo` default rows (empty query now shows real recent PRs + branches).
  - **Cache/preload layer** (`useWorktreeSourceData` + `worktreeSourceCache.ts` +
    `worktreeGithubCacheAtom`) is data-only, no UI surface — documented, deferred to logic tests.
  - D2 clean (0 arbitrary values), D3 unchanged keep-with-reason set (`min-h-[250px]`, `h-[180px]`).
  - **Net new fixes required: 0.**

- **Smart-tab rework landed** (see "Smart-tab rework" section above): two static
  `createSmartSources()` rows → a unified smart input + mixed suggestion list backed by the
  new pure `worktreeSmartInput.ts` (25 unit tests). `createSmartSources` and the modal's local
  `slugFragment` deleted as dead code; `nameToLaunchSource` extracted + shared with the Name
  tab. No new raw HTML (DS `Input` + `SourceRow`), height-stable six-state list. GitLab
  MR / cross-repo PR refs are parsed but kept as honest named-worktree suggestions (no faked
  base).
- **5 of 5 fix candidates landed** (follow-up PR on `junyu/fix-chat-tab-session-activation`):
  1. GitHub search input accessible name — **fixed** (`aria-label`).
  2. GitHub list error state `role="alert"` — **fixed** (`role="alert"` + `aria-live="assertive"`).
  3. PR-resolve error span `role="alert"` — **fixed** (`role="alert"` + `aria-live="assertive"`).
  4. Tab strip WAI-ARIA tab semantics — **fixed** (`tablist`/`tab`/`aria-selected`/`aria-controls`/`tabpanel`).
  5. branch/name `<label>` association — **fixed** (`id` + `htmlFor`).
- **1 sweep candidate landed:** the 3 raw text inputs → **migrated to DS `Input`** (not `SearchInput`),
  carrying the aria-label + label-association fixes in the same change.
- **3 keep (DS / good-practice):** `Button loading`, `max-h-[200px]` token cap, DS `Modal` a11y wrapper.
- **Remaining keep-with-reason:** `SourceRow` button (two-line 44px row, no DS equivalent),
  tab `<button>` **element** kept for the full-underline visual (only its ARIA semantics were added),
  `min-h-[250px]`, `h-[180px]` (D3 stable-height placeholders).
- **Accepted visual deltas from the `Input` migration** (documented in the Fix log at top): inner surface
  `bg-bg-2`+`rounded-lg` (was `bg-bg-1`+`rounded-md`), 14px font (was `text-[13px]`), DS focus ring.

**Verification:** `pnpm typecheck` clean, `pnpm lint` (file) clean,
`worktreeSourceResolve.test.ts` 10/10 pass. No new tests added — the migration extracted no new
pure logic (DS `Input` `onChange` hands back the string directly; existing resolve helpers untouched).
