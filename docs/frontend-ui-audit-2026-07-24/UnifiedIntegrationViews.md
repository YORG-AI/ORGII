# Frontend UI Audit — Unified Integration Views

**Scope:** frontend files brought in by the embedding/compaction integration, including model icon, Chat History, Key Vault registry, and Housekeeper settings hooks.

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/engines/ChatPanel/ChatHistory/index.tsx` | existing chat-history controls | keep with reason | The integration only changes compaction-aware behavior; it does not add a duplicate control surface. | None. |
| `src/modules/MainApp/Integrations/Housekeeper/HousekeeperCategoryView.tsx` | housekeeper settings surface | keep with reason | The removed legacy housekeeper compaction controls are not rendered because their backend subsystem no longer exists. | Keep current settings surface; do not expose orphan overrides. |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| — | — | keep with reason | No new arbitrary Tailwind color/spacing values are introduced by the integration. | None. |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/components/ModelIcon/config.ts` | provider icon mapping | keep with reason | Provider identity mapping is data, not presentation styling. | None. |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/engines/ChatPanel/ChatHistory/index.tsx` | existing compaction presentation | keep with reason | No new interactive UI control or icon-only action was added. | None. |

## D5 — Visual Patterns Observed

- No new visual pattern was added. The integration extends existing Key Vault and chat-history surfaces.
- No sweep candidate was found.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates

**Note:** the configured `frontend-ui-audit` skill file was unavailable in this worktree and user-global skill directory; this report follows the repository's existing audit report format.
