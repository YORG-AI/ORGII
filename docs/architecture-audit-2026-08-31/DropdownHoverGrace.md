# Dropdown hover grace architecture review

## Acceptance criteria and ownership

- A pointer can spend 300 ms between panels and still enter/click the third option.
- Crossing an adjacent row briefly does not dismiss or switch the open submenu.
- Intentional hover switching/dismissal completes after 350 ms; click/keyboard activation remains immediate.
- There is at most one pending hover transition per menu tree, removed on re-entry, hide, disable/close, explicit activation, and unmount.
- Existing click-open behavior and caller-provided hover delays remain intact.

The authoritative source is transient component state, not persisted or remote data. ActionMenuSurface wrote `active = null` immediately from mouseleave and from sibling mouseover. Dropdown and WorkItemContextMenu used short independent leave timers (100/150 ms), and repeated leave events could overwrite the timer handle without canceling the prior callback. No historical data remediation is needed.

`useMenuHoverGrace` owns one cancelable pointer transition. Consumers continue to own their visibility/active submenu state. ActionMenuSurface automatically supplies the fix to session-header and file-header menus without editing those consumers. Dropdown supplies it to all callers using its hover trigger; WorkItemContextMenu uses it at both submenu levels.

## Layer coverage

| Layer                     | Result                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Compilation             | Full `pnpm run typecheck --incremental --tsBuildInfoFile .git/.tsbuildinfo` passes in the clean PR checkout. Changed-file ESLint passes.                                                                                    |
| 2 Ownership/deduplication | Two standalone timer implementations replaced by one production-used hook. No exported unused timing constant, parallel new dismissal engine, or changes to parent consumers.                                               |
| 3 Naming                  | `schedule`/`cancel` describe pointer transition ownership; `setActive` remains immediate.                                                                                                                                   |
| 4 Semantic overloading    | Hover transition and explicit activation have separate paths. Existing menu visibility remains authoritative.                                                                                                               |
| 5 Defaults                | 350 ms is defined once. Undefined delay uses it; zero/nonpositive override remains immediate. Disabled/hidden owners cannot schedule work.                                                                                  |
| 6 Boundaries              | Generic hook depends only on React and DOM; no feature-domain imports or persistence changes.                                                                                                                               |
| 7 Readability             | Cleanup and deliberate pointer-vs-keyboard behavior are documented at the hook and menu event boundaries.                                                                                                                   |
| 8 Wire protocol           | Not applicable: no IPC, API, serialization, or persisted format changes.                                                                                                                                                    |
| 9 Entry parity            | DOM tests exercise actual ActionMenuSurface, inline/portaled Dropdown, and both WorkItemContextMenu submenu levels. Click-persistent sidebar/model/slash menus were inspected and retain their existing dismissal behavior. |
| 10 Resolvers              | Not applicable: no multi-source configuration/data resolver.                                                                                                                                                                |

## Verification

The initial CI run exposed two existing session-header tests that still expected immediate hover switching/dismissal. Both failures were reproduced locally. The consumer tests now use paired pointer events with `relatedTarget` and fake timers to verify the 349/350 ms boundary, bridge re-entry cancellation, one open submenu, and a stable direct app action row. No production behavior was changed for this CI follow-up.

- `pnpm test src/engines/ChatPanel/components/SessionHeaderActionsMenu.test.ts src/modules/shared/components/FileHeader/FileHeaderMoreMenu.test.ts src/components/Dropdown src/hooks/dropdown/useMenuHoverGrace.test.ts src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu/WorkItemContextMenu.test.ts` — 97 tests across 13 files pass, including both real shared-action-menu consumers.
- `pnpm exec eslint src/engines/ChatPanel/components/SessionHeaderActionsMenu.test.ts --max-warnings 0 --report-unused-disable-directives` — passes.
- `node --test scripts/ci/*.test.cjs` — all 28 CI tooling tests pass.
- `pnpm typecheck` — passes for the complete clean PR checkout after the consumer-test update.
- `pnpm test` — the full frontend suite passes: 10,150 tests across 1,288 files, with no failed or skipped tests.
- `pnpm test src/components/Dropdown src/hooks/dropdown/useMenuHoverGrace.test.ts src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu/WorkItemContextMenu.test.ts` — 59 tests across 11 files pass, including 26 new behavior/lifecycle regressions.
- `pnpm exec eslint src/hooks/dropdown/useMenuHoverGrace.ts src/hooks/dropdown/useMenuHoverGrace.test.ts src/components/Dropdown/ActionMenuSurface.tsx src/components/Dropdown/ActionMenuSurface.test.ts src/components/Dropdown/index.tsx src/components/Dropdown/index.hover.test.ts src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu/index.tsx src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu/WorkItemContextMenu.test.ts --max-warnings 0 --report-unused-disable-directives` — passes.
- `pnpm run typecheck --incremental --tsBuildInfoFile .git/.tsbuildinfo` — passes in the clean PR checkout. The earlier failures in the mixed working tree belonged to unrelated untracked Input/Textarea tests; they are not included in this PR.
- `git diff --check` — passes.
- `pnpm run check:circular` — no circular dependencies across 6,335 modules.
- `pnpm exec prettier --check` with the eight changed TypeScript/source-test paths from the ESLint command — passes.
- `pnpm run check:test-placement` — passes across 437 directories.
- Native Tauri pointer travel, physical hit-testing, and CPU/RSS measurement were not run; desktop UI control was not authorized. No measured runtime speedup is claimed.

Risk: menus now wait 350 ms before pointer dismissal/switching. This improves a brief diagonal crossing but is not a geometric safe-polygon implementation and can still close if a user spends longer than the grace period outside both panels. Rollback is confined to the shared hover hook and its three consumers; no data or dependency migration is involved.
