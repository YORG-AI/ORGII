# React Performance Workflow and Verification

## Working Method

1. **State the performance claim.** Name the affected interaction and expected improvement.
2. **Find the owner.** Trace the state, event, async, or bundle boundary before editing.
3. **Establish evidence.** Use a reproducible symptom, render observation, bundle analyzer, browser performance trace, or focused benchmark when practical.
4. **Classify each candidate.** Applicable, adapt, evidence required, or not applicable.
5. **Choose the smallest safe change.** Do not combine unrelated optimization classes.
6. **Sweep equivalent callers.** Classify remaining hits as fix, keep with reason, or not applicable; do not silently stop at the reported site.
7. **Verify correctness first.** Run focused tests, changed-file lint/type diagnostics, and the relevant rendered path when the claim is visual or interaction-based.
8. **Re-measure the original claim.** Do not report a performance improvement solely because code now resembles a best-practice example.

## Verification and Reporting

Match verification to the claim:

| Claim                                | Minimum evidence                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Removed render/remount issue         | Focused regression test where feasible plus before/after render or lifecycle observation             |
| Removed async waterfall              | Focused test for ordering/failure semantics plus timing or call-order evidence                       |
| Reduced bundle/startup cost          | `pnpm analyze` or equivalent chunk evidence before and after                                         |
| Improved long-list interaction       | Reproduce realistic data volume and verify scrolling, focus, selection, and empty/single-item states |
| Fixed listener/subscription overhead | Prove one registration per intended owner and symmetric cleanup                                      |
| Improved live UI responsiveness      | Run the actual Tauri/WebView path or explicitly state that live pixels/profiling were not verified   |

Do not claim runtime, WebView, startup, memory, or frame-time improvements from TypeScript, lint, or unit tests alone. If measurement was not possible, report the change as an implementation candidate with correctness checks, not a verified performance win.

## Relationship to ORGII Delivery Rules

- This skill is performance methodology, not an audit-report mandate.
- It does not replace `.cursor/rules/ui-feature-workflow.mdc` test and acceptance gates.
- It does not require a report for every React edit.
- If a task is explicitly audit-only, keep source changes separate from the audit document.
- When performance and UI consistency both matter, apply both methodologies but keep findings clearly categorized.
