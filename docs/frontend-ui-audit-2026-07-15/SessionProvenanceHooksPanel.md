# Frontend UI Audit: SessionProvenanceHooksPanel

## Scope

- `src/modules/shared/dataSource/SessionProvenanceHooksPanel.tsx` (rewritten + extended)
- `src/modules/shared/dataSource/index.tsx` (host — renders the panel under the
  "Hooks" tab, unchanged this pass)

Context: the "Hooks" view of the Data Sources panel was a plain
`SectionContainer`/`SectionRow` toggle list. It was rewritten to match the
"Scanning" inventory — the shared `SettingsTable` with expandable inline cards —
plus a "Recent signals" table. This pass also covers three follow-on additions:
two new hook platforms (Trae, OpenCode), lazy per-signal **diff patch** expansion
for edit signals, and a clickable session cell that opens the session view.

The configured `frontend-ui-audit` skill file was unavailable at both paths
documented in `AGENTS.md`/`CLAUDE.md`. This pass applies the repository's audit
dimensions directly: shared-component usage, design-token consistency, arbitrary
Tailwind values, accessibility basics, and visual-pattern duplication.

## Findings

| Element                                        | Verdict                                 | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Suggested change                  |
| ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Platform capture list (`HookPlatformsTable`)   | keep with reason                        | Shared `SettingsTable` with the scan inventory's `headerHeight="tall"`, `table-expanded-no-hover table-settings-expanded-compact`, and expandable rows, so both Data Sources views read identically.                                                                                                                                                                                                                                                                 | None.                             |
| Ten platform rows (`PLATFORMS`)                | keep with reason                        | Claude Code / Codex / Cursor / Qwen Code / Droid / Trae / OpenCode / Windsurf / Kimi / Antigravity each map to an existing `IconProvider` (`claude_code`, `codex`, `cursor`, `qwen_code`, `droid`, `trae`, `opencode`, `windsurf`, `kimi`, `antigravity`); no new icon assets. Install formats vary (JSON nested hooks, standalone hooks.json, OpenCode plugin file, Kimi TOML, Windsurf event-keyed arrays, Antigravity owned group) but the row UI is uniform.     | None.                             |
| `SourceIcon` (local)                           | abstract (sweep candidate, not applied) | Duplicates `DataSourcePanel`'s `SourceIcon` (`ModelIcon` + `Terminal` fallback); differing props (`iconId` vs `probe`).                                                                                                                                                                                                                                                                                                                                              | Deferred — low value, cross-file. |
| Status tag / action tag                        | keep with reason                        | `Tag size="mini" … pill` reuses the scan table's status-tag treatment; states map to the shared `TagProps["color"]` scale.                                                                                                                                                                                                                                                                                                                                           | None.                             |
| Capture toggle                                 | keep with reason                        | Shared `Switch` with the prior `loading`/`disabled`/`ariaLabel`/`dataTestId` contract, preserving the accessible label + E2E hook.                                                                                                                                                                                                                                                                                                                                   | None.                             |
| Expanded platform inline card                  | keep with reason                        | `InlineInfoCard` + `INFO_CARD_TOKENS`, matching `DataSourceDetailsCard`.                                                                                                                                                                                                                                                                                                                                                                                             | None.                             |
| Recent signals table                           | keep with reason                        | Second `SettingsTable` with `inlineHeaderToolbar` + search + a `Refresh` action, mirroring the scan table's search + "Rescan all" toolbar.                                                                                                                                                                                                                                                                                                                           | None.                             |
| Session cell = `<button>` → `openSession(...)` | keep with reason                        | Uses the real interactive `<button>` (not a click-`div`), carries a translated `aria-label`, and routes through the shared `useSessionView` hook. Falls back to a shortened monospace id when no reconciled title.                                                                                                                                                                                                                                                   | None.                             |
| Lazy diff expand (`SignalDiffCard`)            | keep with reason                        | Only edit actions (`write/create/delete/rename`) are `rowExpandable`; the patch is fetched on first expand via the existing `getOrgtrackSessionFinalDiffs` RPC (deduped per session in a `useRef` cache), parsed with the shared `parseUnifiedDiffToOldNew`, and rendered with the shared `CodeMirrorDiff` (`viewMode="unified"`, `readOnly`, `autoHeight`). Sources without a diff artifact get a graceful empty state. No new backend or diff renderer introduced. | None.                             |
| Diff container `max-h-[360px] overflow-auto`   | keep with reason                        | Arbitrary max-height, but scoped to cap an embedded editor inside a table row; the page body never scrolls horizontally and the diff scrolls within its own container.                                                                                                                                                                                                                                                                                               | None.                             |
| `text-[12px]` / `text-[13px]` / `font-mono`    | keep with reason                        | Match `INFO_CARD_TOKENS` (`text-[12px]`), section-title tokens (`text-[13px] font-semibold text-text-1`); monospace only on opaque session ids.                                                                                                                                                                                                                                                                                                                      | None.                             |
| `SIGNAL_SOURCE_META` map                       | keep with reason                        | Display-only source→{label,icon} map; falls back to the raw source + `Terminal` icon for unknown sources, so new backend sources degrade gracefully.                                                                                                                                                                                                                                                                                                                 | None.                             |

## Summary

- Fix: 0 applied
- Keep with reason: 11
- Abstract: 1 (sweep candidate, deferred — shared `SourceIcon`)
- Multi-file sweep candidates: 1

No arbitrary colors, raw interactive controls, or duplicated table/diff
implementations were introduced. Color/typography values reuse existing
`text-*` / `text-text-*` tokens or documented `INFO_CARD_TOKENS` /
`SETTINGS_TABLE_*` constants. The diff expansion reuses the app's existing
final-diff RPC + `CodeMirrorDiff` renderer rather than adding a new one, and is
lazy (fetch on expand) with per-session dedup. The one duplication
(`SourceIcon`) is flagged for a possible follow-up abstraction.
