# Claude brand icons UI audit

| Line                                     | Element               | Verdict          | Reason                                                                                                                                                                                                                                                   | Suggested change |
| ---------------------------------------- | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/components/ModelIcon/config.ts:181` | Claude brand identity | keep with reason | Both Claude provider identities now resolve to the existing Claude SVG. Runtime identifiers, display names, and persisted values remain unchanged. README image references use the same asset so the old mascot SVG can be removed without broken links. | None.            |

Verdict totals: **0 fix**, **1 keep with reason**, **0 abstract**.

The central map supplies Claude CLI variants, imported Claude sessions, model icons, and provider pickers. Product names and persisted provider/agent IDs are unchanged. All 13 README asset references are migrated before removing the old mascot SVG. No dependency, runtime, persistence, or lifecycle changes.

Desktop visual checks were not run because Computer Use was not authorized. Visual contrast and hover/collapsed behavior remain unverified in the desktop app. Automated verification results are recorded in the pull request.

Verification in the isolated PR branch: 17 tests passed; scoped ESLint passed with zero warnings; `pnpm run typecheck` passed; `git diff --check` passed.
