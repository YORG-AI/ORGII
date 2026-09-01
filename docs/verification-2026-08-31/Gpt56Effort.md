# GPT-5.6 effort handling

## Source and behavior

OpenAI's [model documentation](https://learn.chatgpt.com/docs/models#know-when-to-use-max-or-ultra)
distinguishes Max reasoning from Ultra's delegation mode. The desktop app may
hide Max until it is enabled in settings. The public API's
[GPT-5.6 model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
supports `xhigh` and `max`; `ultra` is not a public API effort.

The saved account's model variants and the local Codex catalog were inspected
read-only. Both contained `xhigh`, `max`, and `ultra` for Sol/Terra, and `xhigh`
and `max` for Luna. No credentials, preferences, or historical sessions were
changed. No destructive remediation or schema migration is needed for those
records. Live and persisted capability metadata continue to take precedence
over fallback variants.

The producing paths had three inconsistencies:

- Fallback model metadata omitted Max for GPT-5.6. The fallback now emits Max
  for Sol, Terra, and Luna, with Ultra additionally available for Sol/Terra.
- The frontend slider placed Ultra before Max, while the table/default ranking
  omitted Ultra. All three rankings now place Ultra after Max. Separately,
  the requested GPT-5.6 picker policy hides the standalone Max step by default:
  Sol/Terra show Light, Medium, High, Extra High, Ultra; Luna stops at Extra High
  because its catalog does not advertise Ultra. This policy is shared across
  GPT-5.6 pickers, independent of the account supplying the variants.
- Rust parsing erased Ultra into Max, while the public OpenAI effort mapper
  also lowered `xhigh` and `max` to `high`. Parsing now retains Ultra; public
  API requests preserve the selected `xhigh`/`max` value. Unsupported explicit
  selections can fail at the provider instead of silently running lower effort.

Max is real capability data, not malformed data. Its UI exclusion is the
requested product behavior, not data cleanup. The catalog and request resolver
retain Max, and an already-applied Max selection remains visible when editing
it. Opening, dismissing, or changing Fast cannot silently turn it into another
effort or enable Ultra delegation. After selecting a different level, the normal
menu no longer offers Max. Other model families' Max options remain unchanged.

Correctly applying a previously downgraded effort can increase active-request
latency and usage. Ultra can additionally use the existing worker allowance;
it does not change that allowance or create idle work.

Native Codex Ultra requests send `max` reasoning and add bounded delegation
guidance to that request's instructions. This reuses existing subagent tools,
permissions, worker limits, and cancellation behavior. It does not enable tools,
spawn workers itself, change cached prompts, or override user restrictions.
This implements ORGII's delegation guidance; it does not establish full parity
with Codex's internal orchestration.

Ultra's slider fill, label, and focus ring use the existing purple theme token.
Other levels retain the primary accent. The subsequent automatic-update change
removes Cancel/Apply; see [automatic-update verification](ModelPropertiesAutoUpdate.md).

## Architecture coverage

Layers 1–10 were considered within the changed call chain: compilation;
existing shared effort mapping; names; Max/Ultra semantics; default handling;
provider-specific delegation guidance; explanatory comments; serialized wire
bodies; streaming/non-streaming parity; and live/persisted/fallback precedence.
Unrelated session initialization, database schema, and architecture cleanup
were intentionally excluded.

## Lifecycle checks

| Area               | Verdict | Evidence                                                                  | Change or reason kept                                                 | Verification                                             |
| ------------------ | ------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Background work    | keep    | Existing slider-scoped visibility listener and CSS animation              | No new timers, listeners, workers, or polling                         | Hidden/visible and repeated-open listener tests          |
| Memory             | keep    | Fixed 18 decorative comets; per-request instruction string                | No retained mode state or growing buffers                             | Source inspection and request tests                      |
| Scope/isolation    | keep    | Ultra instructions are constructed from the current request's parsed mode | No account writes, cached-prompt mutation, or tool-permission changes | Serialized request tests preserve input and tool absence |
| Rendering/hot path | keep    | One derived accent state; existing native range and CSS motion            | No new subscriptions; reduced-motion rules retained                   | Slider tests and SCSS compilation                        |

## Verification

- `pnpm exec vitest run --config config/vitest.config.ts src/components/ModelPropertiesDropdown/EffortSlider.test.ts src/util/__tests__/modelVariants.test.ts src/util/__tests__/variantEditOptions.test.ts`: 20 tests passed.
- `pnpm exec eslint src/components/ModelPropertiesDropdown/index.tsx src/components/ModelPropertiesDropdown/EffortSlider.tsx src/components/ModelPropertiesDropdown/EffortSlider.test.ts src/util/__tests__/variantEditOptions.test.ts src/util/variantEditOptions.ts src/util/defaultModelVariant.ts src/modules/MainApp/Integrations/KeyVault/shared/ModelTable/ModelVariantInlineCard.tsx --max-warnings 0`: passed with zero warnings.
- `pnpm run typecheck`: passed after the final picker policy change. The first
  attempt was terminated with SIGTERM before diagnostics and is not counted
  as a pass.
- `cargo test -p agent_core -p key_vault --lib gpt_5_6` from `src-tauri`: 4 passed,
  including actual mocked HTTP requests through both chat transports and the
  fallback catalog producing boundary.
- `~/.cargo/shared-target/debug/deps/agent_core-ed837004ecb79b26 core::providers:: --quiet`:
  the freshly built provider test executable passed 446 tests, including native
  Codex and public Responses serialization. Direct execution avoids rebuilding
  or contending for the shared Cargo target lock.
- `~/.cargo/shared-target/debug/deps/key_vault-2ea898359e39b97e codex --quiet`:
  36 Codex catalog/discovery/credential-handling tests passed. Together with the
  provider suite, 482 distinct Rust tests passed.
- SCSS compilation verified the purple token, matching focus ring, and retained
  reduced-motion rules.
- `node scripts/quality/check-test-placement.mjs`: passed across 440 directories.
- `rustfmt --check --edition 2021` on the six changed Rust files: passed.
- `git diff --check`: passed.

Verification used no desktop control or live LLM requests from ORGII. Mock HTTP
requests and serialized request bodies verify the integration boundary, but do
not prove provider acceptance or observed automatic delegation. Full-app visual
inspection and CPU/RSS measurement were not run; no runtime performance gain is
claimed.

Performance verdict: **pass for this scoped change**. No new idle/background
resources or retained state were introduced; listener cleanup and visibility
gating are regression-tested. Active Ultra delegation can consume more usage
within existing limits; its real-world latency and resource cost remain unmeasured.
