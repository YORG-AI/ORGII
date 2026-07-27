# Architecture Audit — Human sessions

**Scope:** Append-only Human-session persistence, optional canonical titles, session-directory integration, shared creator reuse, content routing, and serialized session mentions
**Date:** 2026-07-22
**Auditor:** Codex

## Acceptance criteria

- [x] The user-facing Work log option reuses the regular session creator with an optional title in its upper Work-item-style header row and a single required note while retaining the internal Human-session type.
- [x] A blank title falls back to the existing bounded first-note preview; a nonblank title is trimmed, bounded, and persisted as the canonical session name.
- [x] Creation adds a canonical session row that appears in the Human sidebar group and opens through normal session navigation.
- [x] A Human session is an ordered, append-only note timeline.
- [x] The initial and append composers support session mentions through sidebar drag and `@` selection.
- [x] The reduced API contains only create, get, append, and delete operations.
- [x] Model polish/summarize and dedicated evidence form/storage paths are absent from the implementation.
- [x] Human content never enters agent runtime, transcript, or TUI rendering paths.

## 10-layer audit

### Layer 1 — Compilation correctness

- `pnpm typecheck` and targeted ESLint pass.
- A focused seven-file Vitest run passes 39 tests across the compact launch action, rendered timeline reuse, RPC validation, category placement, sidebar grouping, skill-pill serialization, and session-mention parsing.
- `cargo check -p org2` passes.
- `cargo test -p org2 human --lib` passes all six Human boundary tests, including explicit, blank-fallback, and over-limit title cases.
- `cargo test -p session_persistence init_session_tables_creates_human_session_entry_schema` verifies schema creation and delete cascade.
- Scoped `cargo clippy -p org2 --lib --no-deps -- -D warnings` passes.

### Layer 2 — Dead code and structural deduplication

Production call chains were traced from each entry point:

| Entry point | Forward call chain                                                                                                                                                  | Live owner                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Create      | Shared `SessionCreator` title input + composer → `createHumanSession` → `human_session_create` → canonical titled row + first entry → sidebar refresh → normal open | `agent_sessions::human`             |
| Append      | Human bottom composer → `appendHumanSessionEntry` → one transaction inserts entry and updates canonical `updated_at` → sidebar refresh                              | `agent_sessions::human`             |
| Read/open   | Aggregate directory → typed Human category → `SessionContentView` → ordered entry load                                                                              | session directory + Human feature   |
| Mention     | Sidebar drag or `@` selection → shared Composer pill → stable serialized session reference                                                                          | shared composer/DnD pipeline        |
| Delete      | Sidebar Human branch → `human_session_delete` → canonical delete → entry foreign-key cascade                                                                        | Human command + session persistence |

There is no parallel Human creator, editable document form, model-assist service, link table, or screenshot storage path. The only Human-specific view code is the append timeline and its composer.

### Layer 3 — Naming consistency

- Rust persistence uses `session_type::HUMAN` and aggregate wire category `human`.
- Frontend routing uses `human_session`; prefix routing uses the centralized `humansession-` definition.
- `HumanSession` is the canonical metadata plus entries; `HumanSessionEntry` is one immutable note.
- User-facing copy consistently says “Work log” for the feature, “title” for its optional canonical name, and “note” or “entry” for appended content; persistence and routing retain the established Human-session identifiers. The shared mention menu says “Session,” because it is not agent-only.

### Layer 4 — Semantic overloading

| Term               | Meaning                                                                                          | Verdict                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Human session      | Internal type for a user-authored append-only log represented in the canonical session directory | Keep; distinct category and prefix                            |
| Work log           | User-facing name for creating and opening a Human session                                        | Keep; describes the outcome without presenting it as an agent |
| Agent session      | Runnable agent transcript/runtime                                                                | Keep; Human routing never enters it                           |
| Human entry / note | One immutable timestamped body in a Human session                                                | Keep; one persistence concept                                 |
| Session reference  | Stable serialized `[session:<session-id>]` mention                                               | Keep; references rather than embeds another transcript        |

No Human field is reused as an agent prompt, transcript event, or runtime status.

### Layer 5 — Default branch analysis

- Human prefix/category checks occur before unknown-session fallback to `rust_agent`.
- Aggregate conversion and runtime artifact mapping have explicit Human branches.
- `SessionContentView` checks hydrated category and canonical prefix, allowing deep links before sidebar hydration.
- Sidebar deletion explicitly selects Human deletion; Human rows do not fall into CLI or agent deletion.
- Agent-only transcript/export controls are hidden for Human sessions.

### Layer 6 — Cross-domain concept leakage

- Human entry validation and writes stay in `agent_sessions::human`.
- Shared persistence knows only the new child table and its foreign-key cascade.
- Shared frontend extensions are domain-neutral: the design-system `Input` and its ghost-placeholder token, an accessible icon-button label, optional composer capability flags, a session-content resolver, and a clearly named `hideSessionSetupControls` creator flag. Work logs retain the shared creator's regular plus and round-arrow actions as well as its existing `SessionInfoLine` repository, branch, and location/worktree selectors. The read surface composes the existing shared Work-item activity-timeline primitives without changing their contracts.
- Human sessions reuse directory/pagination/navigation infrastructure without entering agent execution infrastructure.

### Layer 7 — New-developer confusion test

- `human.rs` begins with an append-only timeline description and exposes only four commands.
- `HumanSessionView` is the read/append surface, composes the shared Work-item activity timeline, and reuses the normal bottom `InputArea`; the regular creator reuses its existing upper `composerHeaderContent` slot and the same ghost `Input` title treatment as Work item creation, outside `EditorArea`.
- `SessionContentView` is the single visible content decision between Human timeline and agent chat.
- `TEST_CASES.md` records creation, append, mention, persistence, and deletion behavior, including explicitly deferred features.

### Layer 8 — Wire protocol and serialization

| Payload          |                                                 Bound | Validation                                                                           | Serialized shape                   |
| ---------------- | ----------------------------------------------------: | ------------------------------------------------------------------------------------ | ---------------------------------- |
| Optional title   |                                         80 characters | trimmed and bounded in TypeScript and Rust; blank resolves to the first-note preview | `{ title? }` within create request |
| Initial note     |                                    100,000 characters | trimmed and non-empty in TypeScript and Rust                                         | `{ body, title?, workspacePath? }` |
| Appended note    |                                    100,000 characters | trimmed and non-empty in TypeScript and Rust                                         | `{ sessionId, body }`              |
| Human session ID | UUID with `humansession-` prefix on the Rust boundary | canonical prefix and UUID parse                                                      | string                             |
| Session mention  |                                 one ID token per pill | shared parser/serializer                                                             | `Display [session:<id>]`           |

No model request, base64 screenshot payload, or evidence-specific wire format remains.

### Layer 9 — Init and entry-point parity

| Entry point / host         | Human recognition              | Renderer                  |
| -------------------------- | ------------------------------ | ------------------------- |
| Main ChatPanel             | category or prefix             | `SessionContentView`      |
| WorkStation tab            | category or prefix; GUI forced | `SessionContentView`      |
| Work-item floating session | category or prefix             | `SessionContentView`      |
| Project manager session    | category or prefix             | `SessionContentView`      |
| Task detail session        | category or prefix             | `SessionContentView`      |
| Sidebar initial/load-more  | `human` aggregate category     | normal session navigation |

All hosts use the same resolver. Only session-creation pickers expose Work logs; agent-team, benchmark, and runnable-agent selectors remain agent-only.

### Layer 10 — Resolver symmetry

| Field          | Create                                                          | Append                                                 | Read                                      |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| Human identity | generated canonical prefix + `session_type::HUMAN`              | verified before mutation                               | verified before return                    |
| Note body      | shared 100k/non-empty validation                                | same validation                                        | ordered entry rows                        |
| Timestamps     | canonical + first entry use one timestamp                       | transaction updates canonical row and timestamps entry | canonical metadata + each entry timestamp |
| Workspace      | optional creator repository path                                | unchanged                                              | canonical session value                   |
| Title          | trimmed explicit title, otherwise bounded preview of first note | intentionally stable                                   | canonical session name                    |

The entry table has one ownership chain rooted at `agent_sessions`; deleting the canonical row cascades all entries.

## Systematic sweep

- Swept session category unions, prefixes, aggregate schemas, pagination, sidebar groups, runtime artifacts, content hosts, import/export controls, and delete routing for agent-only assumptions.
- Swept direct session `ChatView` hosts and routed them through `SessionContentView`.
- Swept creator-only category picker consumers so Human is offered only where a new session can be created.
- Swept production and RPC symbols for prior document/update/model/link/screenshot concepts; none remain.
- Swept mention serialization and rehydration across the shared creator and append composer.
- Swept the former Project-Manager-owned ghost placeholder token and promoted it beside the shared `Input` component so Session Creator does not import a project-specific styling module.
