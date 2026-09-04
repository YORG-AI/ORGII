# PinnedActionsBar UI audit

| Line                                                                                      | Element                        | Verdict          | Reason                                                                                                                                          | Suggested change |
| ----------------------------------------------------------------------------------------- | ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/engines/ChatPanel/InputArea/components/PinnedActionsBar/LazyPinnedActionsBar.tsx:5`  | Lazy Skills component boundary | keep with reason | Uses the repository’s Webpack-compatible `React.lazy` and `Suspense` pattern, loading the existing design-system-backed surface only on opt-in. | None.            |
| `src/engines/ChatPanel/InputArea/components/PinnedActionsBar/LazyPinnedActionsBar.tsx:20` | Inactive composer-control row  | keep with reason | Preserves the existing non-Skills leading/trailing control layout without rendering hidden interactive controls or an empty Skills wrapper.     | None.            |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.
