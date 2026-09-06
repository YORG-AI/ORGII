# Claude Desktop connections architecture review

| Layer                     | Evidence and verdict                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Compilation             | Workspace all-target compilation and warnings-as-errors Clippy; final verification is recorded in the PR                                                                                     |
| 2 Ownership/deduplication | Native Desktop generator reuses the existing transaction, locks, snapshots, manifest and restore; shared editor reuses command dispatch and vault                                            |
| 3 Naming                  | Explicit Claude Code CLI, Claude Desktop and Codex selectors; settings renamed App connections without changing the route                                                                    |
| 4 Semantic distinctions   | ConnectionTarget differs from runtime-agent registry; ConnectionAuthScheme differs from provider protocol; key identity differs from target endpoint                                         |
| 5 Defaults                | Target parsing rejects unknown values; Desktop refuses proxy mode; existing CLI option paths reject Desktop overrides                                                                        |
| 6 Domain boundaries       | Desktop is a native configuration target, not a registered executable CLI; native schema generation remains in its adapter                                                                   |
| 7 Discoverability         | Desktop helper owns four documented target files; docs identify native versions, unsupported installations, and restart behavior                                                             |
| 8 Wire contract           | Test and apply share auth/endpoint/model resolution; x-api-key versus bearer is asserted; IPC returns only redacted applied options; no native credential is returned by the new status path |
| 9 Entry-point parity      | Test and apply share selected-profile resolution; apply repeats resolution at the write boundary; direct writer validates Desktop model/auth again; settings and CLI detail share the editor |
| 10 Resolver symmetry      | Endpoint/auth overrides are Desktop-scoped and included in receipt revision; CLI continues to resolve the vault defaults; key eligibility is separate from incomplete endpoint/model editing |

All ten layers reviewed. No unrelated architecture cleanup was included. Existing manifest JSON requires no migration; rollback is restore-before-downgrade. Windows policy reads add only an existing locked dependency version. Native configuration-load and Windows runtime evidence remain unverified and are explicitly documented.
