# Issue #443 frontend UI audit

The repository-listed `frontend-ui-audit` skill was unavailable at both configured paths, so this report applies its documented scope manually to the eight changed TSX files.

| Line                                      | Element                         | Verdict          | Reason                                                                                                                                                                    | Suggested change |
| ----------------------------------------- | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `TurnPageList.tsx:59`                     | Virtualized turn selector       | keep with reason | Reuses existing dropdown tokens and icon-button primitive; virtualization removes the session-sized derived item array without changing interaction semantics.            | None             |
| `BlockOutput.tsx:293`                     | External payload range controls | keep with reason | Uses the shared Button component, bounded 256 KiB reads, request invalidation, disabled states, and an alert role for failures.                                           | None             |
| `SessionRawTranscriptContent.tsx:47`      | Per-payload range viewer        | keep with reason | Uses design-system Button, semantic `article`/`time`/`role=alert`, existing color and spacing tokens, and never assembles the full payload.                               | None             |
| `SessionRawTranscriptContent.tsx:274`     | Virtualized external transcript | keep with reason | `react-virtuoso` keeps rows bounded and preserves logical anchors while older pages prepend; native transcripts retain the existing CodeMirror view.                      | None             |
| `SessionRawTranscriptDialog/index.tsx:54` | Raw transcript dialog actions   | keep with reason | Reuses Modal, Button and Message; Copy is disabled above the memory budget and streamed Export All is clearly exposed. Existing responsive modal dimensions are retained. | None             |
| `SessionRawTranscriptView/index.tsx:15`   | Workstation raw view            | keep with reason | Delegates to the same audited bounded transcript component, avoiding a second UI pattern.                                                                                 | None             |
| `CloudShareImportDialog.tsx:227`          | Cloud import client swap        | keep with reason | Behavioral transport substitution only; rendered component structure and styling are unchanged.                                                                           | None             |
| `SessionImportExportModal.tsx:128`        | Streamed external export        | keep with reason | Existing modal UX remains unchanged; only external sessions switch to the Rust streaming exporter.                                                                        | None             |

Summary: 0 fix, 8 keep-with-reason, 0 abstract. No new arbitrary Tailwind values, duplicate dialog primitives, or basic accessibility regressions were found.

The final module-splitting commit was rechecked on 2026-07-24. Its TSX changes are import, prop-type, and source-neutral naming moves only; rendered markup, CSS, ARIA, keyboard behavior, and the verdict counts above are unchanged.

The final hardening pass added localized Raw Transcript status/error text for all 13 shipped locales without changing rendered structure, design-system components, keyboard behavior, or the audit verdict counts.
