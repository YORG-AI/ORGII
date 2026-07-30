# P2 Journey Visualization Gate

## Capability Matrix

| Capability | Evidence path | Result |
| --- | --- | --- |
| One P1 graph client for Project and Session scopes | `JourneyContainer.tsx`, `ProjectJourneyPage.tsx`, `SessionJourneyPage.tsx`, `renderers/sessionJourney.tsx` | PASS |
| Storyline real-time x-axis, session lanes, typed milestones, explicit idle compression | `JourneyGraph/viewModel.ts::graphToStorylineViewModel`, `components/StorylineTimeline.tsx`, `viewModel.p2.test.ts` | PASS |
| Branches only from factual lineage edges | `JourneyGraph/viewModel.ts::graphToBranchesViewModel`, `viewModel.p2.test.ts` | PASS |
| File lineage only from produced/modified edges and source drill references | `JourneyGraph/viewModel.ts::graphToFileLineageViewModel`, `components/FileLineagePanel.tsx`, `components.p2.test.ts` | PASS |
| Coverage ledger retains represented, merged target, excluded reason, and uncovered fail-close behavior | `JourneyGraph/viewModel.ts::graphToCoverageLedgerViewModel`, `viewModel.p2.test.ts` | PASS |
| Independent provenance/audit indicator remains separate from coverage | `components/CoverageLedger.tsx`, `viewModel.p2.test.ts` | PASS (explicit `notProvided`; P1 payload does not serialize an audit result, so P2 does not infer one) |
| Every rendered graph node and edge exposes evidence class plus source drill target | `components/EvidenceSource.tsx`, `components.p2.test.ts` | PASS |
| Stable deterministic ordering and no timestamp-derived lineage | `JourneyGraph/viewModel.ts`, `viewModel.p2.test.ts` | PASS |

## Commands Run

```bash
npx vitest run src/modules/ProjectManager/JourneyGraph/__tests__/viewModel.p2.test.ts src/modules/ProjectManager/JourneyGraph/__tests__/components.p2.test.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit --pretty false
```

Results:

- Vitest: 2 files, 6 tests passed. Log: `/tmp/p2-vitest.log`.
- TypeScript: exited 2 with exactly 10 pre-existing errors, the documented baseline. None are in P2-touched files. Log: `/tmp/p2-tsc.log`.
  - `src/hooks/keyVault/useLocalKeys.ts` (2)
  - `src/modules/MainApp/Integrations/KeyVault/hooks/refreshAccountModels.ts` (1)
  - `src/modules/ProjectManager/Panels/ProjectManagerSidebar/tabs/ProjectsTab.tsx` (2)
  - `src/modules/WorkStation/TabContent/renderers/projectTree.tsx` (5)

## Scope and Safety

- P2 is frontend-only. No Rust crates, Tauri commands, canonical projector, raw-store query, package dependency, or visualization engine changed; Rust Docker gates are not applicable.
- No dependency was added. The implementation uses the existing React, Lucide, and `TabPill` dependencies.
- The existing throwing P1 client remains the only fetch path. The view models independently reject `uncovered` coverage and missing node/edge evidence, with no demo data or inferred branch/file relationship.
- No install, `.deb` build, `/usr/bin/org2`, live config, credential, or remote push was performed.

## UI Audit Note

`frontend-ui-audit` was required by the repository routing guidance for this multi-component UI delivery, but its declared locations were unavailable in this worktree and user-global configuration (`.orgii/skills/frontend-ui-audit/SKILL.md` and `~/.orgii/skills/frontend-ui-audit/SKILL.md`). No substitute audit report was fabricated.
