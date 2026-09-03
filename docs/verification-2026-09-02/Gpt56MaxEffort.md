# GPT-5.6 Max effort restoration

## Source and invariant

OpenAI's [GPT-5.6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
lists `none`, `low`, `medium`, `high`, `xhigh`, and `max` as supported
reasoning efforts. It recommends `max` for the hardest quality-first workloads
and explicitly distinguishes it from `xhigh`. The individual
[GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
confirms the same capability set.

ORGII's Ultra mode remains a separate harness-level delegation mode. The
selectable order is therefore Light, Medium, High, Extra High, Max, Ultra for
GPT-5.6 Sol and Terra. GPT-5.6 Luna stops at Max because its catalog does not
advertise ORGII's Ultra mode.

## Root cause and fix

The authoritative Codex capability catalog and OpenAI request serializers
already retained Max. A GPT-5.6-specific frontend policy filtered Max out of
the picker, while the Codex CLI launch mapper omitted `max` from its recognized
variant suffixes.

The picker now exposes every capability in canonical order, including Max
between Extra High and Ultra. Codex CLI launches strip `-max` from the base
model and send `model_reasoning_effort="max"`; Fast variants continue to add
the priority service tier.

## Verification

- `pnpm exec vitest run --config config/vitest.config.ts src/util/__tests__/variantEditOptions.test.ts src/components/ModelPropertiesDropdown/EffortSlider.test.ts src/components/ModelPropertiesDropdown/ModelPropertiesDropdown.test.ts src/components/ModelSelectorPill/ModelSelectorPill.test.ts`: 31 tests passed
- `cargo test --lib agent_sessions::cli::session_runner::command_tests::build_codex_` from `src-tauri`: 10 tests passed, covering shell and app-server launch paths plus the invariant that older model families do not acquire Max support
- Focused ESLint: passed with zero warnings
- Focused Prettier check: passed
- Focused `rustfmt --check --edition 2021`: passed
- `cargo check --lib` from `src-tauri`: passed
- `cargo clippy --lib -- -D warnings` from `src-tauri`: passed
- `node scripts/quality/check-test-placement.mjs`: passed across 453 directories
- `pnpm run typecheck`: blocked by three unrelated errors in the existing modified `src/modules/MainApp/WorkManagement/GitHubWorkItemsView.test.ts`; no changed Max-effort file produced a diagnostic

No persisted capability data or historical sessions require remediation: Max
was retained at the authoritative source and only hidden at selection/launch
boundaries.

## Architecture coverage

Layers 1–10 were considered for the affected call chain. Compilation and tests
cover the shared frontend capability projection; the obsolete model-specific
filter/getter was removed rather than replaced with another special case; and
the existing typed reasoning constants remain the shared vocabulary. Serialized
CLI overrides were asserted directly. Both Codex shell and app-server entry
points use the same variant mapper and now have Max coverage. Session
initialization, persistence schemas, and unrelated provider families were
inspected for parity but intentionally left unchanged.
