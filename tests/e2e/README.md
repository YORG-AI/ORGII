# ORGII Core UI E2E (WebDriver)

Drives the debug-built Tauri app with `tauri-webdriver-automation` via WebDriverIO.

The E2E folder intentionally contains only the final core UI regression suite. Keep non-core runtime/config/audit experiments outside this folder so `tests/e2e` stays the clean answer to “what should I run after UI changes?”

## Core UI suite

These are the specs to run after UI changes that can affect chat/session behavior:

- `specs/core/session-matrix-ui.spec.mjs` — rendered launch/reply/tool-card matrix for Cursor CLI/native, Claude Code CLI/Rust, Codex CLI/Rust, Gemini API, and API Rust agents.
- `specs/core/session-controls-ui.spec.mjs` — stop, force-send, queued follow-up, rewind, streaming feedback, Plan/Ask control smoke.
- `specs/core/session-plan-ui.spec.mjs` — canonical Plan lifecycle UI coverage: mode switch, pending side chat, skip, reload, update, build latest, rewind.
- `specs/core/session-account-switch.spec.mjs` — provider account switch matrix across CLI and Rust-native paths.
- `specs/core/session-memory-ui.spec.mjs` — rendered/session-visible smoke for session memory, agent memory, extract memory, and auto dream flags.
- `specs/core/chat-rendering-ui.spec.mjs` — deterministic rendered ChatHistory coverage for tool-card compatibility and duplicate thought/answer deduping.
- `specs/core/session-provenance-live.spec.mjs` — real Claude Code, Codex, and Cursor hooks through Session Blame, transcript navigation, and sidebar reveal.
- `specs/core/diff-tab-content-live.spec.mjs` — real ORG2 agent edit/read through canonical final-diff rendering.
- `specs/core/cloud-org-ui.spec.mjs` — managed ORG2 Cloud org surfaces (create/join, scope, panel, sync-level, share) plus session comments with `@agent` in-place pickup, tri-state thread status, and the slash Address-comments flyout. Offline-safe by default; the backend-dependent scenarios run only with `E2E_CLOUD_*` set in `tests/e2e/.env`.
- `specs/core/work-item-durable-object.spec.mjs` — Work Item durable-object invariants: standalone persistence, ChatPanel link/create, Routine `create_work_item` output policy and concurrency policies, execution locks, and rendered LLM execution/rerun. Four scenarios run against the fixture repo alone; the other nine additionally need a credentialed Rust-agent account — see [Work Item durable-object scenarios](#work-item-durable-object-scenarios).

## Provider capacity policy

Gemini capacity/rate-limit failures are provider capacity unless the rendered UI or ORGII runtime mishandles the error. Core Gemini rows use `E2E_GEMINI_MODEL_CHAIN` to try fallback models in order.

Recommended Gemini chain:

```bash
E2E_GEMINI_MODEL_CHAIN="gemini-3-flash-preview,gemini-2.5-flash,gemini-2.5-pro,gemini-2.0-flash,gemini-1.5-flash"
```

## One-time setup

```bash
cargo install tauri-webdriver-automation --locked
cd tests/e2e && pnpm install
```

Open the app normally once and ensure the KeyVault accounts used by the suite exist. The common defaults are:

- `E2E_OPENAI_ACCOUNT=vincetest1`
- `E2E_CLAUDE_CODE_ACCOUNT=cc1`
- `E2E_CODEX_ACCOUNT=cdx1`
- `E2E_CURSOR_NATIVE_ACCOUNT` or any enabled Cursor token account
- `E2E_CURSOR_CLI_ACCOUNT` or any enabled Cursor API-key account
- `E2E_GEMINI_ACCOUNT=g1`
- Gemini account switch also expects `g2` by default.

### API Rust-agent account requirements

Specs that drive the API Rust-agent path (`session-matrix-ui`, `session-memory-ui`, `session-controls-ui`, `session-plan-ui`, `work-item-durable-object`, and the Agent Org drivers) resolve their account by matching **all** of the following against `window.__e2e.listAccounts()`:

| Env var              | Default        | Matched against                 |
| -------------------- | -------------- | ------------------------------- |
| `E2E_API_AGENT_TYPE` | `openai_api`   | `agent_type`                    |
| `E2E_OPENAI_MODEL`   | `op-4.6-relay` | must appear in `enabled_models` |
| `E2E_OPENAI_ACCOUNT` | any account    | `name` or `id`                  |

The account must also be `enabled`, expose `supports_rust_agents`, and carry an API key or session token.

`E2E_OPENAI_MODEL` is the requirement most often missed: the default `op-4.6-relay` is a specific relay model id, and an otherwise valid account that does not list it in `enabled_models` matches nothing. When no account matches, these scenarios **skip silently** rather than fail. To turn that silent skip into a hard error, name the scenario in its scenario-filter env var — the specs throw `No enabled Rust-agent account matched agentType=… model=… account=…` when a scenario was explicitly requested but no account resolved.

## Workspace fixture policy

The WDIO runner creates a self-contained git fixture repo by default at `/tmp/orgii-e2e-workspace-repo`. Core specs must use that generated repo unless they are explicitly testing a user-provided workspace. This keeps the suite independent from local projects and prevents accidental edits to `yorg_frontend` or another real repo.

The generated repo is rebuilt at runner startup and contains:

- `README.md`
- `package.json` with package name `orgii-e2e-workspace-repo`
- `src/math.ts`
- an initial git commit

Override only when intentionally testing another sandbox repo:

```bash
E2E_REPO_PATH="/path/to/sandbox-git-repo" pnpm test
```

Explicit `E2E_REPO_PATH` values are rejected unless they point to a non-empty git repo containing both `package.json` and `README.md`.

## Running the core suite

```bash
cd tests/e2e
pnpm test
```

Target one core spec:

```bash
cd tests/e2e
pnpm test -- --spec './specs/core/session-plan-ui.spec.mjs'
```

Target a single scenario inside scenario-driven specs:

```bash
cd tests/e2e
E2E_CONTROL_SCENARIOS=plan-update pnpm test -- --spec './specs/core/session-controls-ui.spec.mjs'
```

## Scenario filters

Scenario-driven specs read a comma-separated scenario-filter env var. Every filter is **opt-out**: an unset or empty value runs all of that spec's scenarios, and naming any scenario restricts the spec to exactly those names.

| Env var                        | Spec(s)                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `E2E_CONTROL_SCENARIOS`        | `session-controls-ui`, `session-plan-ui`, **and** `work-item-durable-object` (shared) |
| `E2E_CHAT_RENDERING_SCENARIOS` | `chat-rendering-ui`                                                                   |
| `E2E_LAUNCH_WIRING_SCENARIOS`  | `session-launch-wiring-ui`                                                            |
| `E2E_ROUTINE_UI_SCENARIOS`     | `routine-wizard-ui`                                                                   |

**Always pair `E2E_CONTROL_SCENARIOS` with `--spec`.** One variable is shared by three specs with three disjoint name sets, and `session-controls-ui` / `session-plan-ui` validate it in their `before` hook — a name they do not own aborts them with `Unknown E2E_CONTROL_SCENARIOS=[…]; known=[…]`. Restricting the run with `--spec` keeps the filter scoped to the spec that owns those names. (`work-item-durable-object` does not validate its filter, so a typo there silently skips the whole spec instead of erroring.)

### Work Item durable-object scenarios

`E2E_CONTROL_SCENARIOS` names owned by `specs/core/work-item-durable-object.spec.mjs`:

| Scenario                                     | Account required | Spends tokens |
| -------------------------------------------- | ---------------- | ------------- |
| `standalone-work-item-contract`              | no               | no            |
| `rendered-standalone-work-item-ui`           | no               | no            |
| `chat-panel-work-item-link-create-ui`        | no               | no            |
| `create-work-item-ai-generate-ui`            | no               | no            |
| `routine-create-work-item-contract`          | yes              | no            |
| `routine-create-work-item-failure`           | yes              | no            |
| `routine-concurrency-policies`               | yes              | yes           |
| `create-work-item-auto-execute-guard-ui`     | yes              | yes           |
| `session-link-work-item-ui`                  | yes              | yes           |
| `chat-panel-work-item-session-breadcrumb-ui` | yes              | yes           |
| `routine-create-work-item-ui-llm-execution`  | yes              | yes           |
| `work-item-rerun-ui-llm-execution`           | yes              | yes           |
| `work-item-ui-llm-execution`                 | yes              | yes           |

The four no-account rows drive local UI against the generated fixture repo and need no credentials. The rest resolve an account via [API Rust-agent account requirements](#api-rust-agent-account-requirements) and skip when none matches.

`routine-create-work-item-contract` and `routine-create-work-item-failure` need an account row but never start a session — they assert the `create_work_item` output policy records a durable Work Item and that the created item inherits `selected_account_id` / `selected_model_id` without acquiring an execution lock. The remaining seven launch real sessions against `E2E_OPENAI_MODEL` and spend tokens.

```bash
cd tests/e2e
E2E_CONTROL_SCENARIOS=work-item-ui-llm-execution \
  pnpm test -- --spec './specs/core/work-item-durable-object.spec.mjs'
```

## Running with isolated services

To avoid polluting the main local ORGII home during heavier runs, use an explicit isolated home and ports. Do not pass `E2E_REPO_PATH` unless you intentionally want to override the generated fixture repo:

```bash
export E2E_ISOLATED_RUN=1
export E2E_ORGII_HOME="/tmp/orgii-e2e-home"
export E2E_WEBDRIVER_PORT=4454
export E2E_IDE_SERVER_PORT=13857
export E2E_FRONTEND_PORT=2008
cd tests/e2e
pnpm test -- --spec './specs/core/session-matrix-ui.spec.mjs'
```

For parallel/reused service experiments, set `E2E_REUSE_SERVICES=1` only after starting the app/WebDriver stack yourself.

## `window.__e2e`

Installed by `src/app/root/E2EBootstrap.tsx`, gated to debug/dev builds. Helpers may seed state or inspect runtime, but a core UI spec must still perform a real rendered action and assert an observable rendered result.

Key helpers used by the core suite include:

- `configureWithExistingKey()`
- `listAccounts()`
- `resetToNewSession()`
- `navigateTo()`
- `inspectChatState()`
- `seedChatEvents()`
- `listAllTools()`
- memory helpers such as `debugSeedLearning()`, `learningsList()`, and `debugMemoryPrefetchSection()`

## Data-testid inventory

| testid                   | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `chat-panel`             | Chat panel root                               |
| `chat-input`             | Session creator and in-session editor shell   |
| `chat-send-button`       | Main send/stop/retry button (`data-state`)    |
| `chat-message-list`      | Rendered ChatHistory surface                  |
| `chat-message-assistant` | Rendered assistant message                    |
| `planning-footer`        | Visible planning status footer when populated |
