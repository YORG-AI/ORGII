# Architecture Audit — Onboarding Readiness Flow

**Date:** 2026-08-02
**Scope:** first-run preferences, persisted one-time handoff, sidebar guide completion, cloud invite success boundary

## Verdict

Pass. The flow has one persisted owner (`general.setupWalkthroughProgress`), uses canonical product facts where they exist, and records only the two education actions that have no durable domain equivalent. No UI shadow state or background lifecycle was introduced.

## Layer review

| Layer                                        | Coverage              | Verdict | Evidence                                                                                                                                            |
| -------------------------------------------- | --------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compile / type integrity                  | Full                  | pass    | `pnpm typecheck`; typed enum-backed handoff and milestone values.                                                                                   |
| 2. Dead code / parallel paths                | Full                  | pass    | Removed the three presentation variants and duplicate walkthrough sidebar; advanced theme remains in canonical Settings.                            |
| 3. State machine / ownership                 | Full                  | pass    | `idle → pending → shown`; completion transitions are idempotent and persisted through a functional Settings atom.                                   |
| 4. Semantic overload                         | Full                  | pass    | Session and organization are derived facts; invite and Team Inbox actions use explicitly named education milestones.                                |
| 5. Catch-all state / types                   | Full                  | pass    | No boolean catch-all or string-pattern branching; schema enums constrain every new state.                                                           |
| 6. Cross-domain boundaries                   | Full                  | pass    | Progress helpers live under `store/settings`; cloud invite code no longer imports onboarding UI and writes only after `createCloudInvite` succeeds. |
| 7. Naming / API surface                      | Full                  | pass    | `requestSetupGuideHandoff`, `consumeSetupGuideHandoff`, and `completeSetupGuideMilestone` describe transition intent.                               |
| 8. Wire protocol / persistence compatibility | Full                  | pass    | No RPC shape changed; Zod defaults normalize valid legacy progress with `idle` and `[]`.                                                            |
| 9. Initialization parity                     | Reviewed, not changed | pass    | No new init entry point; completed setup and hidden test-entry converge through the same stored progress schema.                                    |
| 10. Resolver symmetry                        | Not applicable        | pass    | No multi-source resolver or fallback chain was added.                                                                                               |

## State and edge-case matrix

| Condition                                       | Behavior                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Finish succeeds                                 | Preferences completion and pending handoff persist in one batch, then Workstation opens.          |
| Finish persistence fails                        | User remains on setup; no completed outcome or handoff is published.                              |
| Guide opens with pending handoff                | Panel opens and persists `shown`.                                                                 |
| Handoff persistence fails                       | Panel remains usable; stored `pending` can retry on a later mount.                                |
| User skipped setup                              | No handoff is armed.                                                                              |
| Existing completed user lacks new fields        | Defaults to `idle`; no surprise auto-open.                                                        |
| Invite API fails                                | Invite milestone remains incomplete.                                                              |
| Invite succeeds but education persistence fails | Invite remains successful; guide milestone can remain incomplete without corrupting domain truth. |
| Repeated completion action                      | Functional update returns the same object and avoids a disk write.                                |

## Verification

- 38 focused Vitest assertions across setup, locale shape, preference interaction, guide progress, and panel actions.
- TypeScript typecheck and focused ESLint pass.
- Real Tauri flow verified: centered three-row setup → Workstation → one-time four-row guide; existing session/org facts produced `2/4` as expected.
