# Session Creator pinned-action visibility performance guard

## Runtime surface

The feature adds one persisted boolean and one narrow React prop. It adds no timer, listener, worker, subscription, retry loop, IPC command, or unbounded collection. `PinnedActionsBar` already resolves pathless pinned skills through the bounded/coalesced slash-item scanner; hidden pills now produce an empty unresolved-skill key, so that automatic scan does not start. Opening the retained `…` manager remains an explicit demand-driven fetch.

## Lifecycle matrix

| State                        | Required behavior                                                                                             | Evidence                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| App start / restart          | Hydrate one boolean; default or malformed values resolve to visible                                           | Atom persistence suite                                                     |
| Visible idle                 | No scan while hidden; visible pathless skills retain the existing single bounded/coalesced resolution request | `getUnresolvedPinnedSkillsKey` unit coverage and existing scanner contract |
| Hidden document              | No new document lifecycle or recurring work is introduced                                                     | Call-chain inspection                                                      |
| Show → hide                  | Remove pills from rendering without deleting pins; stop new automatic resolution triggers                     | Component and helper tests                                                 |
| Hide → show                  | Re-project the existing pinned set; unresolved visible skills may use the existing scanner                    | Component and persistence tests                                            |
| Compact / hidden repo chrome | Force pills visible because no native menu is available to restore them                                       | View projection and documented test case                                   |
| Multiple creator instances   | Each reads the same bounded persisted boolean; existing scanner coalescing remains unchanged                  | Atom ownership and shared scanner call-chain inspection                    |

## Verdict

| Area               | Verdict | Evidence                                                                                | Change or reason kept                                                                      | Verification                                |
| ------------------ | ------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Background work    | fix     | Pathless pinned skills are the only automatic `fetchFresh` trigger in this path         | Hidden pills return an empty resolution key; explicit `…` management remains demand-driven | Focused helper/component tests              |
| Memory             | keep    | One persisted boolean; existing pinned array and bounded slash-item cache are unchanged | No new collection or app-lifetime registry                                                 | Atom persistence test and source inspection |
| Scope/isolation    | keep    | Session Creator owns the preference; shared bars default visible                        | Compact/hidden-repo surfaces force visible so the control cannot strand hidden UI          | View call-chain inspection                  |
| Rendering/hot path | fix     | Hidden actions previously would still resolve and map pinned skills if only CSS-hidden  | Hidden mode returns no resolved action list and renders no quick-action pills              | PinnedActionsBar tests                      |

No live CPU/RSS capture was run because the change introduces no recurring runtime resource and desktop UI control was not authorized.

**Performance verdict: pass**
