# Architecture audit: Gemini CLI removal

## Acceptance criteria

- Gemini CLI is not registered, detected, installed, launched, parsed, proxied, authenticated, imported, or displayed.
- Gemini CLI-specific Code Assist OAuth and native-provider code is deleted.
- Gemini API-key support remains available as `gemini_api`.
- Antigravity remains a separate provider and uses only its documented CLI,
  authentication, configuration, and migration contracts.
- A persisted legacy `gemini_cli` credential cannot corrupt the key vault and is discarded on the next vault write.

## Ten-layer audit

| Layer                                     | Coverage                                                                                                            | Result                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness                | Rust workspace consumers, frontend types, locale JSON, E2E JavaScript syntax                                        | Pass. Affected Rust crates and the application compile; TypeScript reports no errors.                                               |
| 2. Dead code and structural deduplication | Detectors, OAuth adapter, native Code Assist provider, parser, runner setup, proxy routes, commands, UI setup flows | Removed rather than left behind as unreachable branches. Antigravity uses a separate minimal plain-text parser.                     |
| 3. Naming consistency                     | `ModelType`, CLI registry, binary IDs, validation schemas, icons, translations, tests                               | Active Gemini CLI names are gone. The sole runtime string is a tombstone used only to retire old persisted credentials.             |
| 4. Semantic overloading                   | Gemini CLI OAuth versus Gemini API-key provider and Antigravity                                                     | Separated. `gemini_api` remains an API provider; Antigravity uses its own keyring-backed CLI contract.                              |
| 5. Default branch analysis                | enum matches, provider fallback, parser dispatch, auto-detect dispatch, setup routing                               | No default branch silently routes a removed Gemini CLI value to another provider.                                                   |
| 6. Cross-domain concept leakage           | key vault, runner, storage housekeeping, external import, skill discovery, UI, E2E                                  | Removed Gemini CLI assumptions from every affected domain.                                                                          |
| 7. New-developer confusion                | registry and setup surfaces                                                                                         | There is now one supported Gemini concept in product code: the Gemini API provider. Historical changelog entries remain historical. |
| 8. Wire protocol and serialization        | Rust enum, TypeScript schemas, RPC commands, persisted credentials                                                  | Removed the live wire value. Added a read-time tombstone filter so old rows are ignored and cleaned up safely.                      |
| 9. Init parity                            | main sessions, side queries, fallback providers, goal loop, post-turn processing, subagents                         | Removed the Code Assist session-id/project initialization path from all provider construction entry points.                         |
| 10. Resolver symmetry                     | CLI registry ↔ binary resolver ↔ launch profile ↔ command builder ↔ parser                                          | Gemini CLI was removed from every resolver stage. Antigravity resolves symmetrically to `agy --print` and its plain-text parser.    |

## Systematic sweeps

| Sweep                                           | Verdict             | Notes                                                                                                                                              |
| ----------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GeminiCli` / `gemini_cli`                      | Pass                | Remaining occurrences are limited to the persisted-data retirement filter and its test.                                                            |
| `gemini-cli` / “Gemini CLI”                     | Pass                | Remaining product occurrences are historical changelog text only.                                                                                  |
| `.gemini`, Gemini OAuth/token environment names | Pass                | Removed from active detection, auth, storage, skill discovery, and setup code.                                                                     |
| Gemini API                                      | Keep with reason    | API-key provider support is explicitly outside the removal scope.                                                                                  |
| Antigravity                                     | Adapt independently | Uses `agy`, self-managed keyring/browser authentication, documented config paths, and plain-text print mode; no Gemini OAuth internals are shared. |

## Gemini-to-Antigravity transition follow-up

| Capability                     | Decision               | Reason                                                                                                                                  |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| First-launch account migration | Reuse through `agy`    | Antigravity itself detects legacy profiles and migrates active tokens into the OS keyring. ORGII must not copy or persist those tokens. |
| Local and SSH login            | Delegate to `agy`      | Antigravity owns browser sign-in, remote authorization URLs, authorization codes, logout, and keyring cleanup.                          |
| Non-interactive prompt         | Implement natively     | ORGII launches `agy --print <prompt>`, with documented `--model`, `--add-dir`, and `--conversation` flags.                              |
| Output parsing                 | New Antigravity parser | `--print` returns plain text; Gemini CLI's `stream-json` event parser is incompatible.                                                  |
| Permission mode                | Keep Antigravity flag  | Full-permission mode uses the documented `--dangerously-skip-permissions` option.                                                       |
| Workspace context              | Keep native locations  | Antigravity reads `GEMINI.md`, `AGENTS.md`, and workspace `.agents/skills`.                                                             |
| Global skills                  | Add new path           | Discover `~/.gemini/antigravity-cli/skills`; do not restore legacy `~/.gemini/skills`.                                                  |
| Config discovery               | Update paths           | Track Antigravity settings, keybindings, and MCP files under the documented `.gemini/antigravity-cli` and `.gemini/config` locations.   |
| ACP                            | Mark unavailable       | The published CLI exposes a TUI and print mode, not an ACP transport.                                                                   |

## Verification

- `cargo check -p key_vault -p integrations -p agent_cli -p agent_core -p org2`
- `npm run typecheck`
- Locale JSON validation with `jq`
- Targeted key-store, key-extractor, registry, CLI resolver, and provider-factory tests
- Antigravity command-builder and plain-text parser tests
- Skill-scanner tests for the updated discovery set
- Legacy credential retirement regression test
- E2E JavaScript syntax checks and `git diff --check`

The broader `agent_core` and `key_vault` suites also ran. Their unrelated pre-existing failures are recorded in the delivery summary; all targeted removal tests pass.
