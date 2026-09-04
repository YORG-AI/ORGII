# FileHeaderMoreMenu lifecycle review

| Area               | Verdict | Evidence                                                                                                                                                               | Change or reason kept                                                                      | Verification                                                                                                        |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Background work    | keep    | The dropdown engine owns open-only scroll/resize/outside-click listeners and coalesced positioning frames. The shared surface owns one keydown listener while mounted. | Reuse these owners; no submenu polling, hover timer, network request, or worker was added. | Three trigger-open/outside-close cycles settle to zero timers, no popup DOM, and balanced keydown add/remove calls. |
| Memory             | keep    | Each mounted menu retains one active submenu id and element refs; closing unmounts the surface.                                                                        | No app-lifetime cache or collection.                                                       | Reopening starts with no submenu; the overlay count returns from one to zero on each close and on unmount.          |
| Scope/isolation    | keep    | Submenu state is React-context-local; editor setting values remain controlled props with unchanged parent callbacks.                                                   | No identity, provider, account, or storage ownership change.                               | Tests use an isolated Jotai store and verify callbacks without production data writes.                              |
| Rendering/hot path | keep    | Flyout geometry is measured only when its open subtree renders; scroll/resize positioning uses the existing coalesced engine.                                          | No continuous work or transcript subscriptions introduced.                                 | Advancing fake time for one minute each in visible and hidden states leaves zero timers after settling.             |

Lifecycle scope: closed/open, pointer and keyboard activation, visible/hidden idle, repeated open/close, and unmount. Network, identity switching, provider history, sync transport, and multiple Tauri data homes are inapplicable to this presentation-only change. Existing geometry tests continue to cover the extracted flyout.

Commands:

```sh
pnpm exec vitest run src/modules/shared/components/FileHeader/FileHeaderMoreMenu.test.ts src/engines/ChatPanel/components/SessionHeaderActionsMenu.test.ts src/components/Dropdown/index.test.ts
pnpm exec eslint src/engines/ChatPanel/components/SessionHeaderActionsMenu.tsx src/engines/ChatPanel/components/SessionHeaderActionsMenu.test.ts src/modules/shared/components/FileHeader/FileHeaderMoreMenu.tsx src/components/Dropdown/ActionMenuSurface.tsx src/modules/shared/components/FileHeader/FileHeaderMoreMenu.test.ts --max-warnings 0
pnpm run typecheck
pnpm run check:test-placement
git diff --check
```

Tests: 42 passed. Scoped lint passed. Full typecheck passes on the isolated PR branch based on the latest `origin/develop`. Desktop visual checks and CPU/RSS measurement were not run because computer control was not authorized. No CPU/RSS improvement is claimed from these unit checks.

Performance verdict: pass for the bounded menu lifecycle, evidenced by interaction tests, idle-time advancement, cleanup assertions, and source ownership review. This is not a desktop performance benchmark.
