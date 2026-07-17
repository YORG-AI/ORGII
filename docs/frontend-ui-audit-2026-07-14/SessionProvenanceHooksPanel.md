# Frontend UI Audit: SessionProvenanceHooksPanel

The configured `frontend-ui-audit` skill was unavailable in both the workspace
and user skill directories. This report follows the repository report columns
and existing settings conventions manually.

|                                  Line | Element                                | Verdict          | Reason                                                                                                                                                                                             | Suggested change |
| ------------------------------------: | -------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
|            `dataSource/index.tsx:588` | Scanning / Hooks navigation            | keep with reason | Reuses the existing `TabPill` pattern and adds stable accessible button selectors without introducing a second navigation system.                                                                  | None.            |
|            `dataSource/index.tsx:692` | Hooks content placement                | keep with reason | The shared Runtime panel is the canonical cross-platform hook-management surface; the duplicate per-agent settings entry was removed.                                                              | None.            |
| `SessionProvenanceHooksPanel.tsx:165` | Settings section                       | keep with reason | Uses the shared `SectionContainer`; no one-off card surface, arbitrary spacing, or new color tokens were introduced.                                                                               | None.            |
| `SessionProvenanceHooksPanel.tsx:171` | Platform rows                          | keep with reason | A data-driven platform registry renders the same `SectionRow` structure for Claude Code, Codex, and Cursor, avoiding copy-pasted platform cards. Proper product names do not require translation.  | None.            |
|  `SessionProvenanceHooksPanel.tsx:80` | Privacy, config, and drift description | keep with reason | Existing strings are localized in all 13 supported locales; each row exposes its real config path, structural install drift, and a provider-specific parse/write error when present.               | None.            |
| `SessionProvenanceHooksPanel.tsx:180` | Platform toggles                       | keep with reason | Uses the shared accessible `Switch`, with a platform-specific aria label, per-row loading state, actual installed state from the command result, rollback on RPC failure, and stable E2E selector. | None.            |
| `SessionProvenanceHooksPanel.tsx:119` | Independent async state                | keep with reason | Pending and UI/RPC error state are keyed by platform, while backend status also carries per-config errors; one malformed provider file does not hide the other two rows.                           | None.            |

Verdict counts: fix 0; keep with reason 7; abstract 0.
