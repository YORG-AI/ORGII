# Model properties automatic updates

## Behavior and source of truth

The shared effort popover no longer has Cancel/Apply. Fast and Thinking switches
apply immediately. Slider values preview locally while dragging or holding a
range key, then apply once on pointer/key release or blur. Assistive input that
does not generate pointer/key events applies immediately. The popup stays open;
Escape and outside clicks dismiss it without reverting completed changes.

The caller's model id is authoritative. Each completed control interaction
resolves the full effort/thinking/fast combination before calling `onChange`.
Unsupported Fast is cleared when moving to an effort without that variant;
unavailable combinations and unchanged values do not reach the save callback.
All four dropdown consumers keep their existing session/default-variant save
paths. No provider calls, persistence formats, or backend behavior changed.

The old popover draft/Apply effects and model-table preview map were removed.
A slider keeps only one local interaction and preview, with no pending save timer
or queue. Pointer cancel/unmount drops unfinished previews. Refreshed parent
values invalidate stale gestures; switching model families remounts the slider.
Normal effort updates preserve the input node and keyboard focus.

The compact popup is left-aligned to its trigger so label width changes do not
shift it sideways. It uses measured height for custom placement and omits the
last section's bottom divider. The purple Ultra styling remains unchanged.

## Architecture coverage

Checked compilation, removal of dead preview state, callback naming, the shared
selection/write boundary, invalid/default selections, all four entry points,
and effort/Fast resolution. Provider wire formats, backend initialization, and
cross-instance persistence were not changed or revalidated in this follow-up.
Existing save-error and RPC ordering behavior remains owned by the callers;
this change coalesces slider gestures before invoking those paths.

## Lifecycle evidence

| Area               | Verdict | Evidence                                                                     | Change or reason kept                                                                   | Verification                                                        |
| ------------------ | ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Background work    | keep    | No new timer, listener, worker, or deferred save                             | Existing dropdown listeners are open-scoped; existing slider motion pauses while hidden | Slider visibility/reopen tests and popup overlay dismissal tests    |
| Memory             | fix     | Removed popover draft bookkeeping and per-model preview map                  | One bounded gesture/preview lives in the mounted slider                                 | Cancel/unmount regression test                                      |
| Scope/isolation    | fix     | Gesture captures the original parent value; family changes replace its owner | A refreshed value cannot be overwritten by a stale unfinished drag                      | Stale-drag and external-refresh tests                               |
| Rendering/hot path | fix     | Native input updates only local preview during a gesture                     | One save callback per drag or held-key interaction; switches call once                  | Pointer/key coalescing, duplicate-release, and keyboard-focus tests |

## Verification

- `pnpm exec vitest run --config config/vitest.config.ts src/components/ModelPropertiesDropdown/ModelPropertiesDropdown.test.ts src/components/ModelPropertiesDropdown/EffortSlider.test.ts src/util/__tests__/variantEditOptions.test.ts src/components/SelectorPill/index.test.ts src/components/Dropdown/positioning.portalTransform.test.ts src/components/Dropdown/positioning.verticalFit.test.ts`: 32 tests passed
- `pnpm exec eslint src/components/ModelPropertiesDropdown/index.tsx src/components/ModelPropertiesDropdown/EffortSlider.tsx src/components/ModelPropertiesDropdown/ModelPropertiesDropdown.test.ts src/components/ModelPropertiesDropdown/EffortSlider.test.ts src/components/ModelSelectorPill/index.tsx src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/VariantPill.tsx src/modules/MainApp/Integrations/KeyVault/shared/ModelTable/ModelVariantInlineCard.tsx src/modules/MainApp/Integrations/KeyVault/shared/ModelTable/modelTableGroupColumns.tsx --max-warnings 0`: passed
- `pnpm run typecheck`: passed; the first run caught an unsupported test assertion, which was replaced with this repo's supported assertions
- `node scripts/quality/check-test-placement.mjs`: passed across 440 directories
- `git diff --check`: passed

No desktop control, full-app visual inspection, actual account writes, or CPU/RSS
measurements were used. Browser-native range event ordering in the packaged
WebView was not manually verified. Tests use real React controls and the dropdown
engine in jsdom, with controlled model updates at the public callback boundary.
No measured runtime performance improvement is claimed.

Performance verdict: **pass for this scoped change**. The bounded interaction,
no-background-save, cleanup, and stale-input invariants pass the targeted tests.
Desktop resource measurements and end-to-end persistence are not claimed.

## WebKit drag regression (2026-09-01)

Explicitly calling `setPointerCapture` on the range input prevents WebKit's
native thumb from dragging. The component now leaves capture to the native
thumb. Native release delivery still handles releases outside the rail; the
existing one-save-per-gesture, keyboard, cancellation, and stale-value behavior
is unchanged. No timers, listeners, caches, or persistence paths were added.

A temporary headless Playwright fixture bundled the actual `EffortSlider.tsx`
and compiled its SCSS, with a controlled parent and only translation stubbed.
Real mouse movement reproduced the pre-fix WebKit failure: dragging Extra High
to Ultra left the value at Extra High with no save. With the fix, WebKit 26.5
and Chromium passed drags in both directions, an outside-rail release, a track
click, and an arrow-key change. Each completed gesture saved exactly once;
active drags saved nothing and keyboard focus stayed on the range.

The existing component regression now rejects capture on the input. Injected
jsdom values only verify coalescing; they must not be used as proof that a
native slider is draggable. The headless fixture is component-level evidence,
not a packaged Tauri or full Spotlight end-to-end test. Actual account writes
and the user's desktop remain untested.
