# Claude provider profiles architecture audit

Acceptance: saved per-app profiles do not mutate native files; native activation
uses the entire saved mapping and exact credential/endpoint selection; any profile
or credential change invalidates evidence; existing backup/conflict recovery and
old quick connections remain usable. All 10 layers were reviewed.

| Layer                 | Finding and disposition                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Compilation         | Typecheck, focused Rust tests, and workspace all-target Clippy are recorded in PR verification                                                                                                                                            |
| 2 Ownership/dead code | Settings → typed RPC → profile commands → key-vault resolution + agent-cli catalog/transaction; every new entry point is registered and called                                                                                            |
| 3 Naming              | ClaudeRole and ClaudeModels are native mapping concepts; they do not replace ORGII's existing model aliases or provider identities                                                                                                        |
| 4 Semantic boundaries | Saved profile revision, currently edited draft, active native snapshot, credential reference, and test receipt are distinct                                                                                                               |
| 5 Defaults            | Main role must exist and all four main mappings are explicit; optional Subagent inherits native main-model behavior; unknown roles/auth/targets are rejected                                                                              |
| 6 Domain leakage      | Claude mapping resides in the native adapter crate; key-vault handles credentials/protocol/endpoint only; Codex retains its own editor                                                                                                    |
| 7 Readability         | Separate catalog, role mapping, endpoint discovery, controller, and presentation modules keep storage and network side effects out of the React form                                                                                      |
| 8 Serialization       | Rust native JSON and profile fixtures verify request IDs vs labels, context suffix/flags, family tiers and auth headers; real isolated CLI requests verify all four role IDs; profile metadata is credential-free                         |
| 9 Init parity         | Saves do not activate. Apply re-resolves credentials and validates receipt, then verifies the saved profile under the native operation lock before the existing transaction. Old callers omit the optional profile field                  |
| 10 Resolver symmetry  | Profile endpoint/auth/model are selected coherently; explicit endpoints are not replaced with provider defaults. Discovery has a model-independent endpoint resolver. All mapped IDs are tested once, and evidence binds the full mapping |

Supporting transitions are part of this feature: moving from a mapped profile to
quick or proxy routing clears old role labels/capabilities/subagent/auth overrides.
Nonempty CLI version overrides block activation instead of silently changing the
request model. Regression tests inspect the producing native JSON and catalog,
including save conflict, stale activation, and exact restore.

Compatibility: a version-1 bounded JSON catalog and an optional applied-profile
manifest field; no SQL migration. Restore before downgrade. Native Desktop session
behavior and Windows execution remain unverified; native files/schema fixtures
and current official documentation are the available Desktop evidence.
