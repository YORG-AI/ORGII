# Custom API model catalog architecture audit

All ten layers were covered within the catalog path; unrelated auth and session
architecture was not refactored.

| Layer                      | Finding and disposition                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation             | TypeScript and affected Rust crates are checked; exact commands and results are recorded in the PR Verification section                                                                                                                     |
| 2. Dead code / duplication | Removes both obsolete CRUD snapshot-filter call sites and their helper; reuses ModelAlias, ModelTable, KeyService and provider request builders                                                                                             |
| 3. Naming                  | Existing `alias` is documented as the actual request ID; `display_name` remains presentation-only                                                                                                                                           |
| 4. Semantic overloading    | `new-` no longer means unfinished input; an explicit transient `isDraft` flag owns that state. Custom API suffixes are literal IDs, known provider variants retain their old semantics                                                      |
| 5. Defaults                | Manual setup requires a key, HTTP(S) endpoint and enabled complete ID. OAuth gates remain. An empty enabled list remains empty on save                                                                                                      |
| 6. Domain boundaries       | Native persistence validates IDs before writing; UI does not repair malformed native data through hiding. The only duplicate-row exclusion prefers an explicitly editable manual row when discovery independently reports the same valid ID |
| 7. Discoverability         | Manual rows are visible before discovery; the hint and feature guide explain the save/validate distinction and literal ID behavior                                                                                                          |
| 8. Wire / serialization    | Reuses persisted alias fields; draft markers never enter SaveKeyRequest. The HTTP fixture inspects model, endpoint path, auth and stream mode for both protocols. No label or synthetic suffix replaces a request ID                        |
| 9. Entry point parity      | Native save and health refresh retain explicit IDs; source tests include empty discovery, disabled selection, atomic rejected writes and reload. OpenAI and Anthropic streaming/non-streaming paths share literal Custom API behavior       |
| 10. Resolver symmetry      | Key-first model ID and label are resolved within the same account; registry replacement evicts old key labels. Provider routing still uses the selected credential's endpoint/protocol                                                      |

## Ownership and compatibility

The authoritative source is the Key Vault credential record, written through
`KeyService::save_key` and `update_key_health`. The original producing defects
were replacing the entire catalog on discovery, removing explicit dated enabled
IDs, and clearing wizard aliases during validation. These are corrected before
projection to the picker. No destructive historical cleanup is included.

Wire shape and credentials.json schema remain compatible. Literal Custom API
suffix behavior intentionally changes; configurations relying on synthesized
reasoning suffixes must use the endpoint's real ID. Rollback guidance is in the
feature README. This PR does not add Responses support to ORGII's Custom API
provider; the separate Codex profile feature uses its own Responses contract.
