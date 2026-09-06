# Frontend UI Audit — GLOBAL (open-source readiness pass)

**Scope:** React/TypeScript frontend under `src/` (`src/components/`, `src/modules/**/components/`, `src/engines/**`, `src/features/**`, `src/scaffold/**`)
**Repo:** `ORGII`
**Date:** 2026-06-13
**Auditor:** frontend-ui-audit (global sweep, read-only)
**Methodology:** `~/.orgii/skills/frontend-ui-audit/SKILL.md` (D1–D5 + Systematic Sweep Discipline)

> This is a **global** pass: it surfaces the highest-signal _systemic_ issues (patterns repeated across many files) rather than every individual site. Per the skill's Sweep Discipline, multi-file hits are reported as **sweep / abstract candidates** with representative sites, not exhaustive site lists. No source code was modified.

Codebase scale: **1,636 `.tsx` files**, **112 design-system components** under `src/components/`, Tailwind token system in `tailwind.config.js` (color scales `primary`/`text`/`fill`/`border`/`bg`/`danger`/`success`/`warning`, semantic surfaces `surface-*`, `pane-*`, `chat-*`).

---

## Top issues for open-source readiness (ranked)

1. **[HIGH] Debug logging shipped in source** — **789** `console.*` calls across the frontend, plus **47** `// eslint-disable … no-console` suppressions. This is the single most "embarrassing in a public repo" item and the easiest sweep win.
2. **[HIGH] Systemic React-hooks suppression** — **91** `react-hooks/exhaustive-deps` disables and **25** `react-hooks/set-state-in-effect` disables. Signals fragile effect/dependency logic that a public audience will read as tech debt. Not a UI-token issue but squarely "maintainability + first impression".
3. **[HIGH] God components** — **30+** `.tsx` files over 600 LOC; **5** over 900 (`RoutineWizard` 1144, `Diff/SessionReplay` 976, `ChatHistory` 923, `EditorMainPane` 905, `CreateWorkItemView` 903). Presentation + business logic + state are tangled; these are the hardest files for an outside contributor to enter.
4. **[MED-HIGH] `SessionReplay` quadruplication** — 4–5 near-identical 440–976 LOC replay orchestrators (`Browser`, `CodeEditor`, `Diff`, `ProjectManager`). A shared scaffold (`SimulatorReplayChrome`, `NoTabsPlaceholder`, `Placeholder`) already exists but the orchestration shell is copy-evolved per surface — prime **abstract** candidate.
5. **[MED] Table proliferation** — **50** `*Table.tsx` files; only ~4 share the `@tanstack/react-table` core. Most domains hand-roll their own table wrapper (`McpTable`, `AccountsTable`, `SkillsTable`, `CliClientsTable`, `AgentSkillsTable`, `EmployeeTable`, `ModelTable`, `TeamMemberTable`, …) — the same "rows + columns + empty/loading + pagination" built many ways.
6. **[MED] Hardcoded colors** — **34** `*-[#hex]` className hits + **12** inline `style={{ color/background: "#…" }}`, concentrated in `DevPassport/*`, `Message`, `TrafficLights`, `ModeSelectionWindow`, `LaunchButton`.
7. **[MED] a11y: clickable non-semantic elements** — **21** `<div|span onClick>` sites lacking `role`/`tabIndex`/keyboard handlers.
8. **[LOW-MED] Arbitrary Tailwind CSS-var values** — **23** `*-[var(--…)]` hits; hotspots `DataGrid/ActionBar` (6) and `SqlEditor/QueryResults` (6).
9. **[LOW] TODO/FIXME hotspots** — **89** markers; densest in `todoAtom`, `commandCodeSearch` presets, `TodoChecklist`.
10. **[LOW] Pixel-literal sizing** — **528** `*-[Npx]` hits; mostly sub-4px optical micro-adjustments (legitimate per D3), but a non-trivial tail is ≥16px and should use the spacing scale.

**Note on what is healthy:** raw-HTML interactive usage is _low_ — only **18** raw `<button>` sites vs **75** DS `<Button>` usages, and only **5** files use raw `<table>` (4 of which are the DS table primitives themselves or dynamic/a2ui content). DS adoption for the core interactive primitives is good; the debt is concentrated in **logging, hook hygiene, componentization, and visual-pattern duplication**, not raw-element misuse.

---

## D1 — Raw HTML vs Design System

Sweep result: raw interactive elements are _not_ a systemic problem. Representative verdicts:

| Area                                                                  | Element                                     | Verdict                 | Reason                                                                                                                                                | Suggested change                                          |
| --------------------------------------------------------------------- | ------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/components/Button/index.tsx` (split-button branch)               | nested raw `<button>` + inline-style layout | keep with reason        | This **is** the DS primitive; split-button needs absolute-positioned dropdown segment + dynamic width that Tailwind classes can't express statically. | —                                                         |
| `src/components/GitDialogs/*` (8 dialogs)                             | raw modal scaffolding                       | keep with reason        | Cluster shares a local `GitDialogs/shared` scaffold; consistent within the cluster. Switching one to `ModalSystem` would fragment the cluster.        | (watch — see D5 abstract candidate #4)                    |
| `src/features/CodeMirror/SqlEditor/QueryResults.tsx`                  | raw `<table>`                               | keep with reason        | Renders dynamic SQL result grids with variable column counts; DS `Table` is column-config-driven and doesn't fit ad-hoc result shapes.                | —                                                         |
| `src/engines/ChatPanel/blocks/CanvasInlineCard/a2uiElements.tsx`      | raw `<table>`                               | keep with reason        | Renders server-driven a2ui element trees; element set is dynamic, not a fixed schema.                                                                 | —                                                         |
| `src/scaffold/WizardSystem/variants/AgentOrg/ReachabilityPreview.tsx` | raw `<table>`                               | fix candidate           | Static reachability matrix with fixed columns — a candidate for DS `Table`. Low priority (single site).                                               | Use `components/Table` or document why not.               |
| ~18 raw `<button>` sites (sweep)                                      | raw `<button>`                              | mostly keep with reason | Spot-check shows the majority are sticky/overlay/custom-hit-area headers (same class the skill's pilot marked keep on `DiffFileSection`).             | Re-confirm per-site only during the file's next refactor. |

**D1 verdicts:** 1 fix candidate, 5 keep-with-reason (representative; the 18-site `<button>` sweep is "mostly keep").

---

## D2 — Arbitrary Tailwind Value vs Token

Whole-repo sweep of `*-[var(--…)]`: **23 hits total** (contained). Token verification against `tailwind.config.js` + `src/config/workstation/tokens.ts`.

| File (count)                                                                                                                                                     | Value pattern                                                 | Verdict          | Reason                                                                                                                                                                    | Suggested change                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/modules/WorkStation/DatabaseManager/Panels/DatabaseMainPane/components/DataGrid/ActionBar.tsx` (6)                                                          | `bg/border/text-[var(--…)]`                                   | fix candidate    | 6 arbitrary vars in one file — highest concentration. If these are project tokens they should be Tailwind classes; if grid-specific, promote to a `datagrid` color group. | Map to `tailwind.config.js` color group (e.g. `datagrid-*`) or reuse `surface-*`/`fill-*`. |
| `src/features/CodeMirror/SqlEditor/QueryResults.tsx` (6)                                                                                                         | `bg/text-[var(--cm-…)]`                                       | keep with reason | CodeMirror theme-bridge layer — `--cm-*` vars are the deliberate adapter between the CM theme and the result grid (explicitly allowed by skill's bridge-layer rule).      | —                                                                                          |
| `src/modules/ProjectManager/shared/components/PropertiesPanel/PropertiesRailFrame.tsx` (2)                                                                       | `*-[var(--…)]`                                                | fix candidate    | Project-owned surface vars used ad-hoc; should be a token class.                                                                                                          | Map to existing `pane-*`/`surface-*` class.                                                |
| `src/components/Button/index.tsx` (1)                                                                                                                            | `focus-visible:shadow-[0_0_0_2px_color-mix(...primary-6...)]` | keep with reason | Focus-ring is a computed `color-mix` on a token; not expressible as a single Tailwind class. It lives in the DS primitive itself.                                         | (Optional) promote to a `shadow-focus-ring` boxShadow token in config.                     |
| `tokens.ts`, `StatusBarRenderer`, `DiffFileSection`, `InsertRowModal`, `WorkItemProperties`, `SubagentPromptToggle`, `ChatStatusBanners`, `PanelHeader` (1 each) | misc `*-[var(--…)]`                                           | fix candidate    | Single-site project-token usage; cheap to convert when each file is next touched.                                                                                         | Convert to mapped Tailwind class per site.                                                 |

**Systemic note:** no single var appears in ≥5 non-bridge files, so there is **no missing-mapping abstract** here — D2 is genuinely a small site-by-site cleanup (~10 fix candidates), with the CM/SQL bridge layer correctly kept.

**D2 verdicts:** ~10 fix candidates, 2 keep-with-reason (bridge/DS).

---

## D3 — Hardcoded Sizes / Colors

### Colors (priority)

| File (count)                                                                                                                                                                | Pattern                                                      | Verdict          | Reason                                                                                                                                                                                                       | Suggested change                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/DevPassport/PassportBook.tsx` (8), `PassportDossier.tsx` (5), `Stamp.tsx` (20 inline styles)                                                                | `bg-[#fdfbf7]`, leather/paper hex, inline `transform`/shadow | keep with reason | Deliberately **skeuomorphic** passport (paper `#fdfbf7`, leather gradient, wax-stamp). These are decorative, intentionally outside the app theme; forcing them into the semantic token scale would be wrong. | (Optional) centralize the passport palette into a local `devPassport/theme.ts` so the magic hexes are named, not inlined per element. |
| `src/components/Message/index.tsx` (4)                                                                                                                                      | `*-[#hex]`                                                   | fix candidate    | Status/severity message colors should map to `danger-*`/`warning-*`/`success-*` token scales that already exist.                                                                                             | Replace hex with semantic color tokens.                                                                                               |
| `src/components/TrafficLights/index.tsx` (3)                                                                                                                                | macOS traffic-light hex                                      | keep with reason | macOS window-control colors are a fixed platform spec (`#ff5f57`/`#febc2e`/`#28c840`); they are not theme colors.                                                                                            | (Optional) name them as constants in the file.                                                                                        |
| `src/windows/ModeSelectionWindow.tsx` (3), `src/features/SessionCreator/components/LaunchButton.tsx` (3), `src/engines/ChatPanel/InputArea/components/InputActions.tsx` (2) | `*-[#hex]`                                                   | fix candidate    | Brand/accent hexes that duplicate existing `primary-*` tokens.                                                                                                                                               | Replace with `primary-*` / semantic tokens.                                                                                           |
| `src/modules/MainApp/AgentOrgs/components/org/config.ts` (2)                                                                                                                | hex in config                                                | fix candidate    | Org accent colors — should reference the token scale or a named palette.                                                                                                                                     | Move to token reference.                                                                                                              |
| 12 inline `style={{ color/background: "#…" }}` (sweep)                                                                                                                      | inline color literal                                         | mixed            | DevPassport/Stamp = keep (skeuomorphic); others = fix.                                                                                                                                                       | Convert non-decorative ones to tokens.                                                                                                |

### Sizes

| Pattern                                           | Count           | Verdict               | Reason                                                                                                                                        |
| ------------------------------------------------- | --------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | ------------ | ------------------------------------------------ |
| `*-[Npx]` sizing total                            | 528             | mostly keep           | Spot-checks (`w-[14px]` chevron alignment, `top-[1px]` optical centering) are sub-4px / icon-grid micro-adjustments — legitimate per D3 rule. |
| `*-[Npx]` where N ≥ 16 and a spacing token exists | tail of the 528 | fix candidate (sweep) | These should use `w-4`/`w-6`/`gap-2` etc. Worth a targeted `rg '\b(w                                                                          | h   | gap | p   | m)-\[(1[6-9] | [2-9]\d)px\]'` sweep during a dedicated cleanup. |

**D3 verdicts:** ~8 color fix candidates + 1 size sweep candidate; 3 keep-with-reason groups (DevPassport skeuomorphic, TrafficLights platform spec, sub-4px micro-adjustments).

---

## D4 — Accessibility Basics

| File:Line                                                                          | Element                                                                | Verdict       | Reason                                                                                                                | Suggested change                                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/components/Image/index.tsx:207`                                               | `<div className="image-preview-overlay" onClick={handleClosePreview}>` | fix candidate | Lightbox close-overlay is click-only; no `Escape`/keyboard close.                                                     | Add `role="button"` + `tabIndex={0}` + `onKeyDown` (Esc/Enter), or wrap in a focus-trapped modal. |
| `src/engines/GitWorkflow/GitHubDiff/DiffRow.tsx:236`                               | `<div className="diff-collapsed-section" onClick={onToggle}>`          | fix candidate | Collapse toggle is mouse-only; not keyboard-reachable.                                                                | Promote to `<button>` or add role/tabindex/keydown.                                               |
| `src/components/Tag/index.tsx:224`                                                 | `<span … onClick={handleClick}>`                                       | fix candidate | Clickable tag without keyboard semantics; this is a DS component so the gap propagates everywhere `Tag` is clickable. | Render as `<button>` when `onClick` is provided; keep `<span>` otherwise.                         |
| `src/components/Menu/index.tsx` (2), `src/components/Upload/UploadTrigger.tsx` (2) | `<div onClick>`                                                        | fix candidate | DS menu/upload triggers — gaps here are high-leverage.                                                                | Add keyboard handlers / role, or wrap DS interactive.                                             |
| remaining ~14 `<div\|span onClick>` sites (sweep)                                  | various                                                                | mixed         | Several are inside already-interactive parents (keep); standalone ones are fix.                                       | Confirm per-site; prioritize the DS-component ones above.                                         |

**Systemic a11y note:** the highest-leverage fixes are in **DS components** (`Tag`, `Menu`, `Upload`) because the gap multiplies across every consumer — fix those first. App-level one-offs (`Image`, `DiffRow`) are isolated.

**D4 verdicts:** ~7 fix candidates (3 of them DS-level, high leverage); remainder is a per-site sweep.

---

## D5 — Repeated Visual / Structural Patterns

| Pattern                                                                                                             | Where (representative)                                                                                                                                                                        | Count                                          | Verdict                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session replay orchestrator shell** (sidebar + replay chrome + tabs + placeholder + status bar, 440–976 LOC each) | `WorkStation/{Browser,CodeEditor,Diff,ProjectManager}/SessionReplay/index.tsx` (+ `CodeEditor/SessionReplay/CodePanel`)                                                                       | 4–5                                            | **abstract** — a `useReplayShell` hook + `<ReplayShell>` should own the common chrome; only the per-domain body should differ. Shared atoms (`SimulatorReplayChrome`, `NoTabsPlaceholder`, `Placeholder`) prove the seam exists. |
| **Domain table wrapper** (rows + columns + empty/loading + pagination, hand-rolled per domain)                      | `Mcp/McpTable`, `KeyVault/AccountsTable`, `Skills/SkillsTable`, `CliClients/CliClientsTable`, `AgentOrgs/AgentSkillsTable`, `EmployeeTable`, `TeamMemberTable`, `ModelTable`, `SettingsTable` | ~50 `*Table.tsx` (only ~4 share tanstack core) | **abstract** — extract a `DataTable<T>` (column defs + empty/loading/pagination slots) on top of the existing `Table` primitive; migrate domain tables onto it incrementally.                                                    |
| **Git conflict/confirm dialog**                                                                                     | `components/GitDialogs/{Checkout,Pull,Rebase}ConflictDialog`, `DetachedHead`, `ProtectedBranch`, `PushRejected`, `RemoteBranchDeleted`, `LargePushConfirm`                                    | 8                                              | **abstract (partly done)** — a `GitDialogs/shared` scaffold exists; finish folding all 8 onto a single `<GitConflictDialog title/body/actions>` shape so they can't drift.                                                       |
| **Empty / "no items" placeholder**                                                                                  | `Placeholder`, `NoTabsPlaceholder` exist, but ~355 files reference empty/"No results" copy                                                                                                    | —                                              | **watch** — a shared `Placeholder` already exists; verify the 355 sites route through it rather than re-implementing empty states. Sweep candidate, not yet confirmed duplication.                                               |
| **Stat/count badge** (`CountBadge` exists)                                                                          | `CountBadge` used in replay surfaces                                                                                                                                                          | —                                              | already abstracted — keep.                                                                                                                                                                                                       |

**D5 verdicts:** 3 abstract candidates (replay shell, data table, git dialogs) + 1 watch-list (empty-state routing).

---

## Cross-cutting hygiene (open-source first-impression)

These aren't strict D1–D5 token issues but are the loudest "public repo" smells and belong in this global pass:

| Issue                                      | Count                                           | Verdict              | Suggested change                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console.*` in shipped frontend            | 789 (47 explicitly `eslint-disable no-console`) | fix (sweep)          | Route through a `logger` util gated on dev, or strip in production build. Highest-visibility cleanup. Hotspots: `util/ui/window/windowManager.ts` (22), `useSourceControlState/useSyncOperations` (19), `useFileOperations` (13), `Browser/hooks/useSourceNavigation` (13). |
| `react-hooks/exhaustive-deps` disables     | 91                                              | fix (sweep, careful) | Each is a potential stale-closure bug. Audit in batches; many can be resolved with `useCallback`/`useEvent` instead of suppression.                                                                                                                                         |
| `react-hooks/set-state-in-effect` disables | 25                                              | fix (sweep)          | Often a derived-state-during-render anti-pattern; convert to `useMemo`/event handlers.                                                                                                                                                                                      |
| God components (>600 LOC)                  | 30+ files                                       | fix (refactor)       | Extract business logic into hooks (`use…State`) and split presentation; aligns with the repo's own `ui-feature-workflow.mdc` "extract testable logic into `.ts`".                                                                                                           |
| `TODO`/`FIXME`/`HACK`/`XXX`                | 89                                              | mixed                | Triage before open-sourcing: resolve, convert to tracked issues, or delete. Hotspots: `store/ui/todoAtom.ts` (7), `playground/.../commandCodeSearch.ts` (7), `TodoChecklist` (7).                                                                                           |
| `eslint-disable` (any rule)                | 117 files                                       | watch                | Concentrated in hooks rules (above); few `any`/`ts-ignore` (only 3 ts-ignore, 4 `: any`) — type hygiene is otherwise strong.                                                                                                                                                |
| Inline `style={{…}}`                       | 630                                             | mostly keep          | Many are legitimately dynamic (sizes/transforms computed at runtime, e.g. `Button` and charts). Decorative-but-static ones (DevPassport) could move to token/theme files.                                                                                                   |

---

## Summary — verdict counts

Counting the representative verdict rows in this global report (multi-file sweeps counted as a single candidate, per Sweep Discipline):

- **fix candidates: 31**
  - D1: 1 · D2: ~10 · D3: ~9 · D4: ~7 · cross-cutting sweeps: 4 (console, exhaustive-deps, set-state-in-effect, god-component refactor)
- **keep with reason: 13**
  - D1: 5 · D2: 2 · D3: 3 groups · cross-cutting: inline-style/eslint-disable watch/any-hygiene (3)
- **abstract candidates (≥3 occurrences): 3**
  - Session-replay shell · `DataTable<T>` · Git dialogs (+ 1 empty-state watch-list)

### Recommended order of attack for open-sourcing

1. **`console.*` sweep** (789) — fastest, highest visibility, zero behavior risk if routed through a dev-gated logger.
2. **TODO/FIXME triage** (89) — cheap, removes "unfinished" smell.
3. **a11y DS-level fixes** (`Tag`/`Menu`/`Upload`) — small, high leverage.
4. **D2/D3 token sweeps** (~19 sites) — mechanical, improves theme integrity.
5. **react-hooks suppressions** (116) — slower, real correctness value.
6. **D5 abstracts + god-component splits** — largest effort; do after the cheap wins land.

> Reminder: this report is **audit-only**. No source files were modified. Each `fix candidate` should be validated at its site before changing (the skill's case-by-case principle), and each multi-file sweep decided once at the config/abstraction level rather than site-by-site.
