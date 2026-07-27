# Architecture Audit — ORG2 Cloud session references

## Acceptance criteria

- The copied value includes the full cloud identity tuple: org, owner user, and source session.
- The format is versioned, URL-encoded, non-secret, and distinct from capability-bearing share links.
- One canonical builder and parser own the format.
- Malformed, ambiguous, and unsupported references fail closed.
- Both live and cold-start deep-link entry points resolve the same reference shape.
- The menu action uses the canonical builder, and the parser is wired into production navigation.
- Focused lint, serialization tests, and locale parity pass; the repository-wide TypeScript baseline failure is recorded separately.

## Term-overloading check

| Term               | Meaning                                                                  | Verdict                                      |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------- |
| Session share link | A capability URL containing a one-time `share` credential.               | Keep separate from references.               |
| Session reference  | A non-secret identity URI suitable for issue/PR text and navigation.     | Use `/session/ref` and version it.           |
| Source session ID  | The owner's canonical local/source ID; it can collide across publishers. | Never treat it as globally unique by itself. |
| Cloud session row  | The unique org + owner user + source-session tuple.                      | Encode every dimension in the reference.     |

## Ten-layer audit

|                                     Layer | Coverage                                                                                              | Verdict                                                                                                                                                   |
| ----------------------------------------: | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
|                1. Compilation correctness | Full TypeScript plus focused ESLint and Vitest suites.                                                | Focused checks pass; full `tsc` reaches the pre-existing `sidebarSessionRefresh.ts:30` `changedSources`/`never` error and reports no changed-file errors. |
| 2. Dead code and structural deduplication | Traced menu → builder → clipboard and deep-link event/initial-load → parser → sidebar reveal.         | Builder and parser both have production callers; no test-only abstraction.                                                                                |
|                     3. Naming consistency | Swept `share`, `reference`, `sessionId`, and row-ID terminology in the changed cloud modules.         | `Reference` is used for identity; `ShareLink` remains capability-specific.                                                                                |
|                   4. Semantic overloading | Compared invite links, share links, local `session://` drag payloads, and the new external reference. | New `/session/ref` path cannot cross-parse as `/session?share=`.                                                                                          |
|                       5. Default branches | Inspected parser catch/fallbacks, missing fields, duplicates, fragments, and future versions.         | Parser fails closed; no permissive catch-all or hidden version default.                                                                                   |
|                   6. Cross-domain leakage | Reference codec lives in `features/Org2Cloud`; navigation consumes the parsed domain type.            | No cloud format leaked into generic menu primitives or Rust core.                                                                                         |
|                  7. New-developer clarity | Read builder, parser, menu, and routing call chain without relying on test knowledge.                 | Module comment explains uniqueness, security boundary, and intended text surfaces.                                                                        |
|                     8. Wire/serialization | Asserted the exact emitted URI bytes, URL encoding, round trip, and share-link separation.            | `orgii://cloud/session/ref?v=1&org=…&owner=…&session=…`; no token or endpoint credential.                                                                 |
|                     9. Entry-point parity | Compared Tauri live `onOpenUrl` delivery with cold-start `getCurrent` handling.                       | Both parse and call the same `routeToCloudSessionReference` callback.                                                                                     |
|                     10. Resolver symmetry | Compared required identity fields in builder and parser.                                              | Org, owner, and session are trimmed, required, serialized, and parsed symmetrically.                                                                      |

No layers were skipped.
