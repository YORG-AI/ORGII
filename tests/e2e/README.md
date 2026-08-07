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
