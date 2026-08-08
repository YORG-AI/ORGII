# OAuth model catalog architecture audit

## Scope

The Key Vault add-account wizard, manual validation, automatic credential detection, saved-account refresh, and runtime model-variant handling for Codex and Claude Code OAuth accounts.

## Acceptance criteria

- [x] One backend response owns model IDs, defaults, context lengths, effort variants, and discovery provenance.
- [x] A successful account-visible catalog is authoritative and is not unioned with a baked list.
- [x] Static models are used only as a bootstrap/failure fallback and include GPT-5.6 and Claude Opus 5.
- [x] The models rendered in the wizard retain the same variant metadata when the account is saved.
- [x] Automatic detection does not make a second provider model-list request.
- [x] Stored-account refresh preserves last-known-good models when only fallback discovery is available.
- [x] Codex runtime parsing supports GPT-5.6 fast mode and the `ultra` user-facing suffix.
- [x] Old parallel OAuth list commands and frontend helpers have no remaining references.

## Ten-layer audit

| Layer                                   | Verdict                            | Evidence                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | Pass with unrelated warnings noted | TypeScript typecheck passes. Rust `cargo check` passes for `key_vault` and `agent_core`; its two warnings are pre-existing Windows-only unused parameters in Cursor usage export.                                                                                                                                                            |
| 2. Dead code and structural duplication | Pass                               | Removed the separate static-catalog, Claude live-list, and Codex live-list command surfaces. Claude API-key and OAuth discovery now share one paginated parser. Call chains were traced from wizard login/manual/detect and stored refresh through `oauth_model_catalog`.                                                                    |
| 3. Naming consistency                   | Pass                               | The canonical names are `OAuthModelCatalog`, `oauth_model_catalog`, and `OAuthModelCatalogSource`. A repository sweep found no references to the removed OAuth list helpers/commands.                                                                                                                                                        |
| 4. Semantic overloading                 | Pass                               | `models` means selectable account-visible IDs, `model_variants` means synthetic UI/runtime selections, `default_enabled_models` means base models enabled at setup, and `default_variants` means the selected effort per base model. Live/fallback provenance is a separate enum instead of being inferred from list contents.               |
| 5. Default branches                     | Pass                               | Unsupported OAuth agent types return an error. Missing credentials deliberately select bootstrap fallback. Authentication/authorization failures propagate; only empty or non-auth discovery failures select fallback. Stored refresh rejects fallback rather than replacing last-known-good state.                                          |
| 6. Cross-domain leakage                 | Pass                               | Provider-specific network/auth parsing stays in the Codex and Anthropic validators. The command layer only resolves catalogs; the wizard only maps the typed response into wizard state.                                                                                                                                                     |
| 7. New-developer clarity                | Pass                               | Comments document authoritative-live behavior, bootstrap fallback, saved-account protection, and the reason the reference-price list is not a Codex discovery source. “Codex Subscription” is distinct from an API-key option.                                                                                                               |
| 8. Wire protocol and serialization      | Pass                               | The Tauri request/response schemas explicitly cover optional credentials, models, contexts, variants, defaults, and the snake-case `live`/`fallback` enum. Codex uses the documented app-server `model/list` request and bounds it at 1,000 visible entries; Anthropic uses documented `limit=1000` cursor pagination and capability fields. |
| 9. Entry-point parity                   | Pass                               | See the matrix below: every OAuth entry point resolves through the same catalog service and receives the same metadata shape.                                                                                                                                                                                                                |
| 10. Resolver symmetry                   | Pass                               | IDs, contexts, effort variants, default variants, default-enabled models, and source all follow the same provider response → typed command response → wizard state → save mapping. No field falls back to the reference-price catalog.                                                                                                       |

## Entry-point parity matrix

| Entry point                     | Credential source                  | Canonical catalog call | Preserves metadata                                            | Fallback policy                         |
| ------------------------------- | ---------------------------------- | ---------------------- | ------------------------------------------------------------- | --------------------------------------- |
| OAuth login callback            | Exchanged access/refresh/ID tokens | `getOAuthModelCatalog` | Yes                                                           | Bootstrap allowed                       |
| Manual token validation         | Wizard token                       | `getOAuthModelCatalog` | Yes                                                           | Bootstrap allowed                       |
| Local credential auto-detection | Detected credentials               | `getOAuthModelCatalog` | Yes                                                           | Bootstrap allowed                       |
| Saved-account refresh           | Vault credentials                  | `getOAuthModelCatalog` | Models/contexts; existing runtime synthesis remains available | Fallback rejected; keep last known good |
| Saved-account read              | Persisted catalog                  | `key_info_from_entry`  | Yes; provider ladders fill only missing actionable variants   | No network fallback                     |

## Resolver fallback matrix

| Field                  | Live provider response                        | Static bootstrap                             | Reference-price list | Persisted last-known-good on refresh              |
| ---------------------- | --------------------------------------------- | -------------------------------------------- | -------------------- | ------------------------------------------------- |
| Model IDs              | Yes, authoritative                            | Yes, only on missing/non-auth failure        | No                   | Preserved if live unavailable                     |
| Context lengths        | Yes when provider reports them                | Family/runtime rules                         | No                   | Preserved if live unavailable                     |
| Effort variants        | Yes from capabilities                         | Family rules                                 | No                   | Persisted by wizard; synthesized only when absent |
| Default effort         | Yes                                           | Family default                               | No                   | Persisted by wizard                               |
| Default-enabled models | Provider default intersected with visible IDs | Static default intersected with fallback IDs | No                   | Existing enabled set plus live defaults           |

## Systematic sweeps

| Issue class                              | Sweep                                                                                                   | Result                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Parallel OAuth catalog sources           | Searched Rust commands/handlers and TypeScript services/hooks for the removed list command/helper names | Zero remaining references                                      |
| Claude model parser duplication          | Traced API-key validation, OAuth login, auto-detection, and refresh                                     | One paginated Anthropic catalog parser remains                 |
| Codex reference-data fallback            | Searched wizard model derivation and validation paths                                                   | Reference-price data remains a Cursor-only fallback            |
| Variant metadata loss                    | Traced provider response through render and `SaveKeyRequest`                                            | Provider metadata wins; suffix parsing fills only missing rows |
| Authentication errors hidden as fallback | Audited all discovery error branches                                                                    | 401/403 and common auth error forms propagate                  |

## Performance and lifecycle review

| Area               | Verdict | Evidence                                                                                                                                  | Change or reason kept                                                                                                                                  | Verification                                   |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Background work    | Keep    | Discovery runs only on explicit login, validation, detection, or refresh; there are no timers, polling loops, subscriptions, or idle work | One catalog request per action; Codex app-server has a 10-second timeout, kill-on-drop, explicit kill/wait, bounded stderr, and temporary-home cleanup | Static lifecycle trace plus Rust compile/tests |
| Memory             | Keep    | Catalog vectors are request-scoped; Codex limit is 1,000 and stderr capture is capped at 20,000 bytes                                     | No retained cache or unbounded collection added                                                                                                        | Unit parsing/catalog tests                     |
| Scope/isolation    | Keep    | Credentials are passed per request; Codex uses a unique temporary home; stored refresh refuses fallback replacement                       | No cross-account cache or shared mutable catalog                                                                                                       | Catalog-source and authoritative-live tests    |
| Rendering/hot path | Keep    | Discovery is outside render and only updates wizard state after completion                                                                | Removed duplicate model requests and price-list recomputation                                                                                          | Focused wizard tests, lint, and typecheck      |

Performance verdict: pass

## Verification

- `pnpm typecheck` — passed.
- ESLint over all changed TypeScript/TSX files — passed.
- Focused Vitest wizard suite — 3 files, 5 tests passed.
- `cargo check --manifest-path src-tauri/Cargo.toml -p key_vault -p agent_core` — passed with two pre-existing Cursor/Windows unused-parameter warnings.
- `cargo test --manifest-path src-tauri/Cargo.toml -p key_vault --lib commands::tests::tests::` — 12 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p key_vault --lib oauth_auth_failures_are_not_hidden_by_the_fallback_catalog` — 1 passed.
- Full `key_vault` library suite — 337 passed; one unrelated environment-sensitive PATH fingerprint test failed because both fingerprints were `"-"`.
- The focused `agent_core` test target compiled, but the shared Windows test binary could not start (`STATUS_ENTRYPOINT_NOT_FOUND`). Runtime-specific assertions remain present in the compiled unit-test source; `agent_core` passes `cargo check`.
- `git diff --check` — passed.

The `frontend-ui-audit` skill referenced by `AGENTS.md` was unavailable at both documented locations. The change keeps the existing visual structure; repository lint, typecheck, and focused behavior tests were used as the fallback review.
