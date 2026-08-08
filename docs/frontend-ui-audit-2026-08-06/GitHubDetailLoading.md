# Frontend UI Audit — GitHub Detail Loading

## Scope

Initial loading for dedicated GitHub Issue and Pull Request tabs in both the
chat pane and WorkStation, including lazy-renderer loading and first-detail
fetches.

The configured `frontend-ui-audit` skill file was unavailable at both documented
locations, so this report applies the repository's audit format and the existing
GitHub Issue/PR detail conventions directly.

## Findings

| Line                                | Element                       | Verdict          | Reason                                                                                                                                                           | Suggested change                                                                              |
| ----------------------------------- | ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GitHubDetailSkeleton/index.tsx:19` | Shared GitHub detail skeleton | abstract         | Issue and PR tabs need the same stable first-paint contract across chat and WorkStation; one kind-aware component prevents host-specific loading markup.         | Keep lazy-module and initial-data fallbacks routed through this shared component.             |
| `GitHubDetailSkeleton/index.tsx:24` | Loading semantics             | keep with reason | `role="status"`, `aria-busy`, a localized accessible label, hidden decorative blocks, and reduced-motion support expose loading without spinner churn.           | Keep the skeleton non-interactive and preserve the motion-reduction path.                     |
| `GitHubDetailSkeleton/index.tsx:50` | Detail content width          | keep with reason | `max-w-[920px]` intentionally matches the canonical Work Item thread column, preventing a width jump when an Issue skeleton resolves to real content.            | Retain the established detail-column width until a shared layout token is added.              |
| `surfaceRenderers.tsx:95`           | Chat-pane lazy fallbacks      | fix              | `fallback={null}` painted an empty pane while the Issue/PR renderer chunk loaded and did not reserve the eventual detail hierarchy.                              | Render the matching GitHub detail skeleton immediately.                                       |
| `UnifiedTabContent.tsx:34`          | WorkStation lazy fallbacks    | fix              | The generic full-pane loading placeholder used a centered spinner for dedicated GitHub detail tabs.                                                              | Select the Issue/PR skeleton by tab type while preserving other tab fallbacks.                |
| `PrDetailPanel.tsx:442`             | PR first-fetch boundary       | fix              | Fresh PR state begins with `loading=false` and `detail=null`; painting the real layout before the effect flips loading caused the reported content flash.        | Treat unresolved, error-free detail as initial loading from the first render.                 |
| `GitHubIssuePanelView.tsx:17`       | Issue first-fetch boundary    | keep with reason | Cold/persisted Issue tabs with a resolvable remote use the skeleton, while seeded issue data, explicit errors, and non-loadable empty states retain their paths. | Keep cached/seeded issue content immediate and use the skeleton only while a request can run. |

## Verdict counts

- fix: 3
- keep with reason: 3
- abstract: 1

## Accessibility and visual-system notes

The skeleton uses existing semantic color, border, radius, spacing, and surface
tokens. It is announced as a localized busy status, all placeholder geometry is
decorative, and pulse animation is disabled under reduced-motion preferences.
No new interactive controls or arbitrary colors were introduced.
