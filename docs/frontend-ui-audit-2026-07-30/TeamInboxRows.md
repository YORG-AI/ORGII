# Team Inbox Rows — Frontend UI Consistency Audit

The configured `frontend-ui-audit` skill file was unavailable in both the
workspace and user-global locations, so this report applies the repository's
documented output columns as a manual consistency review.

| Line                       | Element                               | Verdict          | Reason                                                                                                                                                                                                                       | Suggested change                                    |
| -------------------------- | ------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `TeamInboxListItem.tsx:28` | Shared PR / Work Item row shell       | abstract         | Both item types need the same selected, hover, spacing, title/time, preview-clamp, and metadata behavior. The shared component delegates those tokens to `getListItemClasses` instead of introducing a second visual system. | Keep both adapters on this primitive.               |
| `TeamInboxListItem.tsx:82` | Compact time and secondary text       | keep with reason | Both item types use compact no-`ago` timestamps with `text-text-3`; metadata remains `text-text-2`, and only mention rows use the bounded two-line preview treatment.                                                        | No change.                                          |
| `TeamInboxList.tsx:309`    | PR status icon                        | keep with reason | The icon is item-specific semantics inside the shared shell. Its color derives from the canonical PR status variant, while its size and slot are shared with Work Items.                                                     | No change.                                          |
| `TeamInboxList.tsx:321`    | PR author avatar and compact metadata | fix              | The row needs author recognition without repeating the login. It now uses the shared metadata line for avatar, PR number, repository, and source branch; the image has a no-broken-image failure state.                      | No further change.                                  |
| `TeamInboxRow.tsx:94`      | Work Item row adapter                 | abstract         | Work Item-specific text derivation remains in the adapter; all presentation structure moved to the shared row primitive.                                                                                                     | Keep domain formatting out of the shared component. |

## Verdict counts

- Fix: 1
- Keep with reason: 2
- Abstract: 2
