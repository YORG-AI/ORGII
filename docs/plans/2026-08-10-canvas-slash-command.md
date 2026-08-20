# Canvas Creation Slash Command

## Scope

Add `/canvas` as one built-in creation command shared by the in-session composer and Session Creator. Selecting the command inserts an atomic pill, while submission keeps the serialized pill in chat history and sends a deterministic creation contract to the Agent.

Canvas home, recent Canvas sessions, sharing, and existing-Canvas revision behavior are intentionally outside this change.

## End-to-end data path

1. `buildBuiltinSlashItems` registers Canvas once for both composer entry points.
2. Inline slash selection and pinned-action selection call `insertAtomicSlashActionPill`.
3. `ComposerInput` serializes the pill as `canvas [skill:/canvas]` and preserves any request typed after it.
4. The existing submit boundary expands the serialized skill pill to `/canvas`, removes editor-only payloads, and calls `resolveAgentMessageContent`.
5. Exact `/canvas` commands become an Agent-only Canvas creation contract. The original serialized text remains the user-visible and persisted message.
6. Existing session dispatch owns pending, success, failure, retry, and composer restoration behavior.

## State machine

| State | Trigger | Result | Exit |
| --- | --- | --- | --- |
| Idle | User types `/` or opens pinned actions | Canvas is available as a built-in action | Select or dismiss |
| Command inserted | User selects Canvas | Atomic `/canvas` pill is inserted and focused | Type a request or submit |
| Preparing | User submits | Display text is retained; Agent content is projected | Existing dispatch starts |
| Needs requirements | Bare `/canvas` | Agent is instructed to ask what to build and not call the Canvas tool yet | User replies |
| Creating | `/canvas <request>` | Agent is instructed to call `render_inline_canvas` exactly once for a new Canvas | Existing tool/session lifecycle |
| Failed send | Existing dispatch rejects | Existing snapshot restoration restores the composer | User retries or edits |

No new timers, subscriptions, polling, caches, workers, or retained async resources are introduced.

## Edge-case matrix

| Input / condition | Expected behavior | Coverage |
| --- | --- | --- |
| `/canvas build a timer` | Create a new Canvas using the exact request | Parser and Agent-projection tests |
| Bare `/canvas` | Ask for requirements; do not call the tool | Parser test |
| Uppercase `/CANVAS` | Accept as the same command | Parser test |
| Multiline request | Preserve every request line | Parser test |
| `please use /canvas later` | Do not intercept ordinary prose | Parser test |
| `/canvasish` or `/canvas/design` | Do not intercept lookalike commands | Parser test |
| Canvas plus terminal/session context | Put the creation contract first and append context | Agent-projection test |
| Interceptors disabled | Preserve the owning composer's normal behavior | Agent-projection test |
| Inline slash menu | Use the shared built-in registry and atomic insertion helper | Registry and insertion tests |
| Pinned Canvas action | Insert the same atomic pill | Rendered component test |
| Editable and sent pill | Use the Canvas icon without changing other skill icons | Rendered component tests |

## Acceptance criteria

- Canvas appears in the shared built-in command list with localized copy.
- Inline and pinned entry points insert the same atomic `/canvas` pill.
- The user-visible message remains unchanged after submission.
- Only exact Canvas commands receive the Agent-side creation contract.
- Bare commands ask for requirements rather than creating an empty Canvas.
- Existing non-Canvas slash actions and skill-pill icons keep their behavior.
