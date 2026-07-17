# Shared Account Details Architecture Audit

Scope: extracting Key Vault account details from the Settings ownership tree and consuming them from both Settings and the Chat launchpad.

## Completion checklist

- [x] TypeScript typecheck succeeds.
- [x] ESLint succeeds for every touched TypeScript/TSX file.
- [x] Existing Chat panel start-page tests succeed.
- [x] One production implementation owns account detail, status, compatibility, and badge behavior.
- [x] Shared modules do not import from `MainApp`.
- [x] Chat defers detail code and detail-specific compatibility requests until selection.
- [x] Old Settings import paths are compatibility re-exports rather than duplicate implementations.

## Ten-layer findings

| Line     | Element                  | Verdict        | Reason                                                                                                                                                                                                                   | Suggested change                                                                |
| -------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Layer 1  | Compilation correctness  | pass           | `npm run typecheck -- --pretty false`, scoped ESLint, and the focused Vitest suite all pass.                                                                                                                             | None.                                                                           |
| Layer 2  | Structural deduplication | pass           | `AccountInlineDetails`, compatibility, badges, status colors, and layout primitives each have one implementation. Existing Settings paths only re-export them.                                                           | Remove compatibility re-exports only when all downstream imports have migrated. |
| Layer 3  | Naming consistency       | pass           | The canonical name describes the rendered body (`AccountInlineDetails`); the former `AccountInlineStatusSection` survives only as a compatibility alias.                                                                 | Prefer the canonical name in new code.                                          |
| Layer 4  | Semantic overloading     | pass           | `account` consistently means `KeyVaultAccount`; `status` is account readiness/health; `details` is presentation over the same account record. No term carries a second domain meaning.                                   | None.                                                                           |
| Layer 5  | Default branches         | pass           | Selection explicitly toggles open/closed. Async completion clears only the matching account ID, preventing an older refresh from clearing a newer selection's loading state. Failed refresh retains cached account data. | None.                                                                           |
| Layer 6  | Cross-domain leakage     | pass           | `src/modules/shared/keyVault` contains no imports from `src/modules/MainApp`; Settings depends on shared code, not the reverse.                                                                                          | Keep this dependency direction.                                                 |
| Layer 7  | New-developer clarity    | pass           | Layout primitives, account-domain components, and launchpad orchestration have separate owners and purpose-based names.                                                                                                  | None.                                                                           |
| Layer 8  | Wire protocol            | not applicable | No wire type or serialized payload changed. The launchpad calls the existing `refreshAccount(accountId, true)` boundary.                                                                                                 | None.                                                                           |
| Layer 9  | Entry-point parity       | pass           | Settings and Chat render the same canonical detail component from the same `KeyVaultAccount` shape. Chat adds its surface-specific footer and on-demand refresh only.                                                    | Keep surface chrome outside the canonical body.                                 |
| Layer 10 | Resolver symmetry        | pass           | Both entry points use the same internal quota, overview, credential, badge, and compatibility resolvers because they share the component implementation.                                                                 | None.                                                                           |

## Entry-point matrix

| Entry point        | Account source                | Detail renderer                    | Compatibility resolver               | Status renderer                                | Surface behavior                                  |
| ------------------ | ----------------------------- | ---------------------------------- | ------------------------------------ | ---------------------------------------------- | ------------------------------------------------- |
| Key Vault Settings | `KeyVaultAccount` table row   | Shared `AccountInlineDetails`      | Shared `AccountCompatibilitySection` | Shared `AccountStatusIndicator` via action bar | Existing inline table expansion                   |
| Chat launchpad     | `useKeyVault().localAccounts` | Lazy shared `AccountInlineDetails` | Mounted only after selection         | Shared `AccountStatusIndicator` in footer      | Refresh on selection, inline expansion after tile |

## Default and async branch matrix

| Condition                           | Result                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| No selected account                 | No detail code mount and no compatibility request                       |
| Select an account                   | Mark selected, refresh that account, dynamically import detail renderer |
| Select the same account again       | Collapse the detail surface                                             |
| Select B before A refresh completes | B remains loading; A's completion cannot clear B's loading state        |
| Refresh fails                       | Loading clears and the existing cached account remains available        |

No wire-payload, fallback-chain, FSM, or serialization changes were introduced, and no systematic issue class outside the extracted ownership boundary was found.
