# Architecture Audit — Codex Reauthentication

**Scope:** expired-login detection, repair routing, Key Vault readiness, account replacement, OAuth auto-start, and return navigation
**Date:** 2026-07-21
**Auditor:** Codex

## 10-layer audit

### Layer 1 — Compilation correctness

- The split branch passes the scoped TypeScript pre-commit check and targeted ESLint.
- Twenty targeted route and error-classification Vitest tests pass.
- Common-error translations are complete across all 13 locales with zero missing keys.

### Layer 2 — Dead code and structural deduplication

- The chat error action calls the public route builder; the Key Vault page consumes the matching parser.
- `hasLoaded` comes from the key-store request lifecycle rather than a duplicate page-level inference.
- Auto-start is passed through the existing Key Vault wizard stack without adding a second OAuth implementation.

### Layer 3 — Naming consistency

- `buildCodexReauthPath` and `parseCodexReauthIntent` form an explicit route codec.
- `CODEX_REAUTH_RETURN_TO_STATE_KEY`, `hasLoaded`, and `autoStartCodexLogin` describe their ownership and purpose.

### Layer 4 — Semantic overloading

| Term             | Meaning                                                          | Verdict                                          |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| reauthentication | Replace rotating OAuth credentials for an existing Codex account | Keep; distinct from adding an unrelated account. |
| return-to state  | Trusted in-app route restored after saving repaired credentials  | Keep; constrained to `/orgii/app`.               |

### Layer 5 — Default branch analysis

- Non-Codex and generic 401 errors retain the existing error presentation.
- Ordinary Key Vault add flows remain unchanged when `reauth=codex` is absent.
- Missing explicit account IDs fall back only when exactly one Codex account exists.

### Layer 6 — Cross-domain leakage

- URL construction remains in `config/mainAppPaths`; the chat item invokes the public builder.
- Key-store readiness and account resolution remain in Key Vault hooks and page orchestration.
- The shared wizard receives typed intent props without importing chat/session state.

### Layer 7 — New-developer confusion test

- The route, state key, account resolution, and auto-start intent are named at their ownership boundaries.
- Comments explain why an expired Codex login needs reconnection instead of retry.

### Layer 8 — Wire protocol and serialization

- Route construction and parsing are tested with URL-encoded query parameters.
- Return navigation accepts only `/orgii/app` paths.
- No backend OAuth credential or RPC wire type changes.

### Layer 9 — Init parity

| Entry point          | Readiness                  | OAuth callback            | Completion              |
| -------------------- | -------------------------- | ------------------------- | ----------------------- |
| Normal Key Vault add | Existing behavior          | Existing behavior         | Models page             |
| Codex error repair   | Waits for initial key load | Desktop callback in Tauri | Original in-app session |
| Web OAuth            | Existing behavior          | HTTP callback             | Existing behavior       |

### Layer 10 — Resolver symmetry

- Reauthentication resolves an explicit account first, then the sole-Codex-account fallback.
- The resolved ID is used consistently for duplicate-name exclusion and saving the replacement credentials.

## Systematic sweep

- Checked all 13 `common` locale files; `errors.*` completeness reports zero missing keys.
- Checked Codex expired-login signals so generic 401s and other providers do not enter this flow.
- Traced the full path from chat action through route state, Key Vault load, wizard auto-start, save, and return navigation.
