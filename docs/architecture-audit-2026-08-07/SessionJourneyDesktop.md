# Session Journey Desktop

## Scope

Desktop Journey command adapter, typed Tauri client, and session-header UI.

## 10-Layer Checklist

| Layer | Result | Notes |
| --- | --- | --- |
| 1 Compilation | Partial | Focused Vitest and ESLint pass. Rust test is blocked because `cargo` is unavailable in this workspace shell. |
| 2 Call chain | Keep | `SessionJourneyControls` -> `sessionJourneyApi` -> Tauri command -> `SessionJourneyApplicationService`; no second mutation path. |
| 3 Naming | Keep | `sessionJourneyApi` is the only frontend command boundary; UI names distinguish task, fork, checkpoint, and review. |
| 4 Terms | Keep | `review` means durable review queue item; `fork` means branch, never a task alias. |
| 5 Defaults | Keep | UI never invents an anchor. Anchor mutations are disabled until an exact selected message ID exists. |
| 6 Leakage | Keep | Tauri adapter has no UI/lifecycle decision; UI has no database/provider import. |
| 7 Developer clarity | Keep | Chinese UI text is localized at the component boundary and command errors retain Chinese prefixes. |
| 8 Wire protocol | Fix | Request DTOs now declare `serde(rename_all = "camelCase")`; frontend request types match them. |
| 9 Init parity | Keep | Desktop registration contains all 11 Journey commands; snapshot polling is read-only and does not initialize a second runtime. |
| 10 Resolver symmetry | N/A | This change has no multi-field override/cache/DB resolver. |

## Sweep

Searched all Journey command registrations and frontend `journey_*` invocations. The only frontend command strings are centralized in `src/api/tauri/sessionJourney/index.ts`; all 11 desktop adapters remain registered exactly once.
