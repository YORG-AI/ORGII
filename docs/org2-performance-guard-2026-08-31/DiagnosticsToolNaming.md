# ORG2 diagnostics naming and English output

The standalone tool now lives in `tools/org2-diagnostics`. Its README, help,
status and error messages, recorder output, and generated Markdown reports use
English and ORG2 branding. Package commands and Git ignore exceptions point to
the new directory. No app runtime code or dependencies changed.

The workspace-local `.orgii/diagnostics` state path and legacy `orgii`
executable detection are intentionally retained. Existing recordings and
active-session ownership must not split across two storage locations during a
tool rename. JSON schemas, verdict codes, command options, and user-provided
Unicode marker labels remain compatible.

## Review scope

Architecture review covered compilation, naming, default-path compatibility,
contributor documentation, serialized report compatibility, CLI entry points,
and resolver behavior. Domain semantics, cross-domain ownership, UI structure,
and Rust code are unchanged and were not audited.

| Area               | Verdict | Evidence                                                                             | Change or reason kept                                           | Verification                                                                                            |
| ------------------ | ------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Background work    | keep    | Recording still owns its sampling timer, file watcher, and signal handlers           | No cadence, stop condition, or cleanup changes                  | Production AST parity; real record/mark/stop lifecycle test                                             |
| Memory             | keep    | Sampling limits, process-detail caps, and direct-to-disk sample writes are unchanged | Naming and language changes require no retention changes        | AST parity; bounded defaults test; one-sample CLI smoke                                                 |
| Scope/isolation    | keep    | PID/start-time identity and the existing active-session path remain authoritative    | Preserve legacy recordings and reject stale ownership as before | PID replacement test, legacy executable test, unchanged state-path assertion, released-lock smoke check |
| Rendering/hot path | keep    | Tool remains an external CLI with no frontend imports                                | Only text literals and one internal function name changed       | AST comparison of all six production modules; translated report and CLI checks                          |

Lifecycle verification covered an idle status read, rejected idle mark/stop,
recording, a workflow marker, external stop, sample-limit completion, report
generation, and active-lock cleanup. Process fixtures also verified rejection
after root PID reuse. No network, authentication, app visibility, or
secondary-app topology behavior changed.

## Verification

- `pnpm diag:test`: all 13 tests passed before and after the rename.
- `node tools/org2-diagnostics/cli.mjs --help`: English ORG2 help text.
- `pnpm exec prettier --check tools/org2-diagnostics`: passed.
- Scoped whitespace and stale-reference checks passed; the renamed library files are not ignored by Git.
- Temporary CLI smoke exercised process audit and JSON output, idle status, usage and ownership errors, a one-sample recording, report regeneration, and lock cleanup using isolated temporary state.
- AST comparison against the pre-edit snapshot found only translated text and the internal root-candidate function rename across all six production modules. Numeric limits, control flow, data fields, regexes, and storage paths are unchanged.
- The manifest comparison confirmed that this task changed only the three diagnostics script paths, preserving earlier unrelated edits.

Tests ran on macOS. Linux was not executed, Windows sampling remains
unsupported, and no long-duration memory benchmark or GUI inspection was run.
No CPU or memory improvement is claimed.

Performance verdict: pass
