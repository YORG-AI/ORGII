# Claude Desktop connections UI audit

| Line                               | Element                        | Verdict          | Reason                                                                                                                    | Suggested change |
| ---------------------------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `HarnessConnectionsSection.tsx:48` | App selector                   | keep with reason | Reuses SegmentedTextPill; overflow container accommodates narrow settings panels; target key unmounts the previous editor | None             |
| `HarnessConnectionsSection.tsx:60` | Import and add flows           | keep with reason | Reuses the existing credential import and key vault wizard                                                                | None             |
| `ConnectionCards.tsx:28`           | Responsive card group          | keep with reason | One/two-column token-based layout, named group, DS Button with pressed state and keyboard behavior                        | None             |
| `ConnectionCards.tsx:37`           | Selected and configured states | keep with reason | Primary outline marks draft selection; a separate configured label marks the applied connection                           | None             |
| `ConnectionCards.tsx:48`           | Endpoint text                  | keep with reason | Semantic text tokens and wrapping; no literal colors or fixed widths                                                      | None             |
| `DesktopConnectionFields.tsx:32`   | Endpoint field                 | keep with reason | DS Input, explicit accessible label, shared settings control dimensions                                                   | None             |
| `DesktopConnectionFields.tsx:42`   | Authentication                 | keep with reason | DS Select; literal wire-header names clarify which credential header is sent                                              | None             |
| `DesktopConnectionFields.tsx:57`   | Manual model ID                | keep with reason | DS Input supports provider IDs absent from discovery without changing shared key metadata                                 | None             |
| `DesktopConnectionFields.tsx:67`   | Credential explanation         | keep with reason | Shared SectionRow and description token; translated in all 13 locales                                                     | None             |
| `HarnessConnectionEditor.tsx:132`  | Shared actions/status          | keep with reason | Existing SectionLayout, DS controls and live status remain shared with CLI details; no additional action dispatcher       | None             |

Verdict totals: **0 fix**, **10 keep with reason**, **0 abstract**.

Rendered DOM tests cover target selection and Desktop fields/actions; native desktop screenshots and light/dark/narrow visual inspection were not performed because computer control was not authorized. The report records source consistency, not a visual pass. No cross-file design-system sweep candidates were found within this feature.
