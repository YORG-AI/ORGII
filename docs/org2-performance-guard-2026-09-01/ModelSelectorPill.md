# ModelSelectorPill lifecycle review

Scope: the new compact/advanced settings popup and optional fitting behavior in the shared action submenu. No polling, requests, caches, workers, or persistence formats were added.

| Area               | Verdict | Evidence                                                                                                                                                                 | Change or reason kept                                                                                | Verification                                                                                                                               |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Background work    | keep    | `useDropdownEngine` owns open-scoped positioning, outside clicks, and its resize observer. `ActionMenuSurface` owns its mounted keyboard listener and hover-grace timer. | One stable outer panel across views; advanced keyboard ownership is unmounted for the native slider. | Repeated open/view-switch/close test verifies listener removal, overlay count returning to zero, and no retained timers.                   |
| Memory             | keep    | Only a view boolean and DOM refs are added. The existing menu owns one active submenu and one cancellable hover timer.                                                   | Bounded per-instance state; closing unmounts the panel tree.                                         | Component unmount assertions and headless disposal checks pass.                                                                            |
| Scope/isolation    | keep    | Variant availability comes from the existing account-filtered hook; changes use its existing apply callback.                                                             | No new account/session cache or asynchronous writer.                                                 | Unsupported Fast, unchanged selection, preserved selected Max, and fallback-control tests pass. Real-account persistence is not exercised. |
| Rendering/hot path | keep    | The existing native slider keeps drag preview local and commits on release. CSS owns decorative motion; its scoped listener pauses it while hidden.                      | No per-frame JS work or extra animation loop.                                                        | Slider tests cover visibility and cancellation; real WebKit/Chromium drag releases and keyboard steps save once.                           |

Lifecycle coverage: closed idle, compact visible, advanced visible, repeated view changes, outside dismissal, Escape, and disposal are exercised. Hidden-document behavior is covered by the existing slider/hover-grace tests. Network, account migration, provider ingestion, and multi-instance transport are unchanged and outside this component refactor.

Commands run successfully:

```sh
pnpm test src/components/ModelSelectorPill/ModelSelectorPill.test.ts src/components/Dropdown/ActionMenuSurface.test.ts src/components/ModelPropertiesDropdown/EffortSlider.test.ts src/components/ModelPropertiesDropdown/ModelPropertiesDropdown.test.ts src/components/SelectorPill/index.test.ts src/util/__tests__/variantEditOptions.test.ts src/components/Button/index.test.ts
pnpm exec eslint src/components/ModelSelectorPill/index.tsx src/components/ModelSelectorPill/ModelSettingsMenu.tsx src/components/ModelSelectorPill/ModelSelectorPill.test.ts src/components/ModelPropertiesDropdown/EffortSlider.tsx src/components/Dropdown/ActionMenuSurface.tsx src/components/Dropdown/DropdownItem.tsx --max-warnings 0
pnpm exec tsc --noEmit --incremental --tsBuildInfoFile .git/.tsbuildinfo-combined-model-pill --pretty false
git diff --check
```

All 45 targeted tests pass. The temporary headless Playwright fixture compiles the production pill, popup, slider, dropdown engine, and variant resolver, with fixture account hooks, translation, and icon loading. WebKit and Chromium checks cover light/dark layouts, a narrow viewport, native dragging, keyboard/hover menus, left alignment, and overlay disposal.

Performance verdict: **pass for the scoped component lifecycle**. No CPU/RSS improvement is claimed. Packaged Tauri, real-account writes, and desktop CPU/RSS measurement were not run; Computer Use was not authorized and was not invoked.
