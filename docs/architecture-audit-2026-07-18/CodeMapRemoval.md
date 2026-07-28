# Code Map Removal Architecture Audit

## Scope and acceptance criteria

This audit covers removal of the Code Map feature from the Rust workspace, Tauri command surface, agent tool/prompt surface, frontend runtime and UI, storage reporting, tests, translations, and generated Cargo dependency metadata.

- [x] Remove the `code-map` workspace crate and every direct dependency.
- [x] Remove all Code Map Tauri commands and TypeScript bindings.
- [x] Remove `use_code_map` and `manage_code_map` definitions, registration, policy entries, prompts, wire names, schemas, and renderers.
- [x] Remove automatic/manual indexing, status, cancel, clear, and storage-management surfaces for this feature.
- [x] Remove feature-specific frontend components, hooks, state, E2E helpers/specs, and translations.
- [x] Preserve independent search, semantic-search, LSP, and UI-indexing systems.
- [x] Leave no Code Map identifiers or filenames in production/test source.
- [x] Pass Rust compilation, TypeScript compilation, focused Rust tests, focused frontend tests, lint, and formatting checks for the changed frontend files.
- [x] Run Clippy across all targets; it exits successfully with existing unrelated warnings and no warning in a changed Code Map removal site.

## Call-chain trace

| Entry point        | Previous path                                                                                             | Result                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| App startup        | `AppDeferredServices` → `AutoIndexingProvider` → `useAutoIndexing` → Tauri index commands                 | Entire path removed                                             |
| Workspace overview | status panel → Code Map hooks/API → status/index/cancel/clear commands                                    | Panel, hooks, API, and commands removed                         |
| Agent execution    | execution-mode prompt → tool catalog/registry → `CodeMapTool` or `ManageCodeMapTool` → `code_map` service | Prompt guidance, tools, registration, and service crate removed |
| Storage settings   | `get_disk_usage` → `code_map_root`                                                                        | Category, resolver, path helper, and locale labels removed      |
| Rendered E2E       | browser helper → Code Map Tauri commands                                                                  | Helper types, bootstrap wiring, and spec removed                |

## Term-overloading table

| Term                  | Meaning                                            | Verdict                                                 |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Code Map / `code_map` | Removed persistent symbol/dependency graph feature | No live source usage remains                            |
| `code_search`         | Independent text/file/symbol search tool           | Keep; it does not depend on the removed graph index     |
| semantic index        | Independent embedding-backed search storage        | Keep; separate crate, commands, settings, and data path |
| “code mappings”       | Generic provider function-name mapping test        | Keep; unrelated English phrase, not a feature reference |

## Ten-layer audit

| Layer                                     | Coverage                                                                                                                                 | Verdict                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness                | `cargo check`, `pnpm typecheck`, focused tests, ESLint, Prettier, and Clippy were run                                                    | Pass. Workspace-wide rustfmt currently reports unrelated pre-existing formatting drift; changed Rust removal hunks introduce no formatting issue. |
| 2. Dead code and structural deduplication | Traced all five entry paths above and deleted their now-unreachable implementations, tests, exports, and state                           | Pass; no compatibility shim or placeholder abstraction remains.                                                                                   |
| 3. Naming consistency                     | Swept identifiers, command strings, tool names, event classification, locales, filenames, and Cargo metadata                             | Pass; source/test sweep is empty.                                                                                                                 |
| 4. Semantic overloading                   | Compared the removed graph feature with `code_search`, semantic search, UI indexing, and generic “code mappings”                         | Pass; independent systems were intentionally preserved.                                                                                           |
| 5. Default branch analysis                | Removed the explicit fallback-renderer branch and event-category match arms for the two tool wire names                                  | Pass; removed names cannot silently fall into a feature-specific default branch.                                                                  |
| 6. Cross-domain leakage                   | Removed Code Map references from shared session modes, security policy, storage infrastructure, event types, and workspace overview      | Pass.                                                                                                                                             |
| 7. New-developer confusion                | Removed stale comments, prompts, labels, scheduler exports, and test helpers                                                             | Pass; no discoverable feature shell remains.                                                                                                      |
| 8. Wire protocol and serialization        | Removed seven Tauri commands, two tool wire names, TypeScript invoke wrappers, schema-specific real-tool tests, and event classification | Pass; there is no remaining Code Map payload or schema to serialize. Generic optional-enum schema tests remain.                                   |
| 9. Init parity                            | Audited app startup, UI/manual, agent-tool, storage, and E2E entry points                                                                | Pass; every Code Map initializer/entry point is removed rather than left asymmetric.                                                              |
| 10. Resolver symmetry                     | Audited the removed workspace/path/status/query resolution code and all callers                                                          | Not applicable after deletion; no Code Map resolver remains.                                                                                      |

## Dependency and wire cleanup

- Removed `crates/code-map` from workspace members.
- Removed `code_map` from the app and `agent_core` dependency graphs.
- Regenerated `Cargo.lock`; the `code_map` package and dependency edges are absent.
- Removed `USE_CODE_MAP` and `MANAGE_CODE_MAP` constants and their stability assertions.
- Removed Code Map tool schemas, catalog entries, policy groups, read-only denial entries, and prompt instructions.

## Verification evidence

| Command                                                                      | Result                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------ |
| `cargo check`                                                                | Pass                                       |
| `cargo clippy --all-targets`                                                 | Exit 0; unrelated existing warnings remain |
| `cargo test -p agent_core --lib core::tools`                                 | 563 passed                                 |
| `cargo test -p core_types --lib tool_name_constants_are_stable_wire_strings` | 1 passed                                   |
| `cargo test -p org2 --lib new_storage_roots_are_reported`                    | 1 passed                                   |
| `pnpm typecheck`                                                             | Pass                                       |
| Targeted ESLint                                                              | Pass                                       |
| Targeted Prettier check                                                      | Pass                                       |
| Fallback adapter Vitest suite                                                | 14 passed                                  |
| Exact source/test identifier and filename sweep                              | No feature hits                            |
