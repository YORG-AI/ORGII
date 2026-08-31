# Work Item To-Do removal

## Scope

Audited the Work Item To-Do presentation and its owning update path while removing the feature from both thread and standard detail surfaces. Persisted To-Do data remains readable by history and prompt-building compatibility paths.

## Findings

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/modules/ProjectManager/WorkItems/components/WorkItemContent/index.tsx` | To-Do section composition | fix | Both Work Item presentations mounted an editable checklist even though the section no longer provides enough product value. | Remove the section, its imports, and its scroll-trail destination. |
| `src/modules/ProjectManager/WorkItems/components/WorkItemContent/hooks/useWorkItemContentState.tsx` | To-Do update callback | fix | Once the editor is removed, the dedicated immediate-update callback has no caller and would leave a misleading mutation path. | Delete the callback and returned hook field. |
| `src/components/TodoChecklist/index.tsx` and Work Item adapters | Checklist component stack | fix | The generic checklist, Work Item wrapper, thread variant, normalization helper, and focused tests have no remaining production consumer. | Delete the dead component stack rather than hiding it behind presentation conditionals. |
| `src/modules/ProjectManager/WorkItems/components/WorkItemContentStack.tsx` | Dedicated To-Do layout slot | fix | The slot and padding override exist solely for the removed checklist. | Remove the props and render branch so the layout API reflects its live sections. |
| `src/types/core/workItem.ts`, history, and prompt-building paths | Persisted `todos` compatibility | keep with reason | Existing Work Items and imported/session-derived data may still contain To-Do snapshots. Removing the storage field would silently discard data and require a separate migration decision. | Keep read/transport compatibility, but expose no editable Work Item To-Do UI. |

## Summary

- Fix: 4
- Keep with reason: 1
- Abstract: 0
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the referenced user-global and workspace locations. This report follows the repository's documented audit table convention and covers the removed UI and retained compatibility boundary directly.

## Architecture layers

- Covered: compilation, dead-code reachability, naming/API surface, semantic ownership, default behavior, cross-domain leakage, and new-developer clarity.
- Intentionally skipped: wire-format symmetry, initialization parity, and resolver/registry duplication because the retained `todos` storage contract, RPC payloads, and initialization paths were not changed.
