# SessionFilterButton UI audit

| Line                          | Element                 | Verdict          | Reason                                                                                                                                                                                    | Suggested change |
| ----------------------------- | ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionFilterButton.tsx:375` | Show-recent trigger row | keep with reason | Reuses `DropdownItem`, the shared dropdown sizing and active-state tokens, a barrel-exported Hugeicon, and the same suffix pattern as the adjacent grouping control                       | None             |
| `SessionFilterButton.tsx:557` | Shared settings submenu | keep with reason | Reuses `DropdownPanel`, the existing viewport-clamped anchor logic, and icon-free `DropdownItem` selection semantics; a separate submenu scaffold would duplicate the established pattern | None             |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.
