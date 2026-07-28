# Upstream Provenance

This ORGII skill is a thin compatibility overlay for Vercel Engineering's React Best Practices skill. The upstream rule set is not copied into this repository so that ORGII-specific constraints remain small and reviewable.

## Pinned Source

- Repository: <https://github.com/vercel-labs/agent-skills>
- Skill: <https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices>
- Upstream version: `1.0.0`
- Pinned revision: [`dc8367e6f91c022d83361f03c3313fa05e848ee5`](https://github.com/vercel-labs/agent-skills/commit/dc8367e6f91c022d83361f03c3313fa05e848ee5)
- Revision date: 2026-04-14
- Upstream author/organization: Vercel Engineering
- Upstream skill license declaration: MIT

## Reading Upstream Rules

Use the pinned paths when detailed examples are needed:

- Compiled guide: <https://raw.githubusercontent.com/vercel-labs/agent-skills/dc8367e6f91c022d83361f03c3313fa05e848ee5/skills/react-best-practices/AGENTS.md>
- Skill summary: <https://raw.githubusercontent.com/vercel-labs/agent-skills/dc8367e6f91c022d83361f03c3313fa05e848ee5/skills/react-best-practices/SKILL.md>
- Individual rule template: `https://raw.githubusercontent.com/vercel-labs/agent-skills/dc8367e6f91c022d83361f03c3313fa05e848ee5/skills/react-best-practices/rules/<rule-name>.md`

Always apply `SKILL.md` in this directory after reading an upstream rule. The ORGII overlay wins when the upstream guide assumes Next.js, RSC, SSR, server request lifecycle, SWR, or dependencies not present in ORGII.

## Updating the Pin

When updating upstream:

1. Read the upstream diff from the current pinned revision to the candidate revision.
2. Reclassify added or changed rules using ORGII's applicability filter.
3. Update incompatible examples or exclusions in the overlay first.
4. Update the revision and version in both `SKILL.md` and this file.
5. Verify that no update silently introduces a Next.js/SWR/server-only recommendation into the ORGII default path.
