# Claude provider profiles UI audit

Scope: new profile editor, model rows, and Settings app selector. Final-state review
covers D1–D5. The pass corrected nonexistent color tokens, profile-card clipping,
and mixed-unit responsive breakpoints before producing the attached previews.

| Line                               | Element                                   | Verdict          | Reason                                                                                                                                           | Suggested change |
| ---------------------------------- | ----------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `ClaudeProfileEditor.tsx:69`       | Profile editor scaffold                   | keep with reason | Uses SectionContainer/SectionRow and shared settings description/control tokens                                                                  | None             |
| `ClaudeProfileEditor.tsx:147`      | Profile cards                             | keep with reason | DS Button with primary/secondary outline appearance, native pressed semantics, and separate active badge                                         | None             |
| `ClaudeProfileEditor.tsx:152`      | Card height override                      | keep with reason | `height: auto` allows multiline card content; the standard DS button's fixed height clipped the endpoint                                         | None             |
| `ClaudeProfileEditor.tsx:215`      | Endpoint/key/auth controls                | keep with reason | Reuses Input and Select with accessible labels and the shared control width                                                                      | None             |
| `ClaudeModelMappings.tsx:86`       | Role matrix                               | keep with reason | Responsive editable form uses a grid; a fixed table cannot stack fields on a narrow Settings pane                                                | None             |
| `ClaudeModelMappings.tsx:140`      | Container breakpoints and column template | keep with reason | Local 600/800px content thresholds and 6rem/5rem role/capability columns keep two flexible model fields aligned; no global token sweep is needed | None             |
| `ClaudeModelMappings.tsx:129`      | Model suggestions                         | keep with reason | Native datalist augments the DS Input without preventing manual IDs or adding a catalog cache                                                    | None             |
| `ClaudeModelMappings.tsx:184`      | Context checkbox                          | keep with reason | Uses Checkbox; a screen-reader-only role label distinguishes repeated 1M controls                                                                | None             |
| `HarnessConnectionsSection.tsx:51` | App selector                              | keep with reason | Uses SegmentedTextPill and blocks tab changes while the profile has unsaved edits                                                                | None             |

Verdict totals: **0 fix**, **9 keep with reason**, **0 abstract**.

Headless component previews: `docs/claude-provider-profiles/{light,dark,narrow}.png`.
Native Desktop and Tauri visual interaction were not run; computer control was
not authorized. No shared component or global theme changes are part of this PR.
