# Workspace and Matrix E2E Policy

## Multi-repo workspace regression policy

Multi-root behavior must be treated as a first-class product contract, not a display patch.

- Distinguish durable session root, primary workspace folder, active editor folder, search result source repo, and tool-event target path. Do not use active editor focus as a durable session root unless the user explicitly selected it.
- Explicitly test that `activeFolderAtom` / active editor focus can move to a secondary repo without changing the durable launch root. Agent session launch defaults to the primary workspace folder; active folder is only a UI/current-focus concept.
- Every multi-repo UI test should include at least two repos with colliding filenames so source attribution cannot be inferred from basename alone.
- `@` search and context menus must render persistent source evidence (`repoName`/path badge), not only hover-only titles.
- File-path extraction must go through a shared extractor that handles canonical payload variants (`file_path`, `filePath`, `target_file`, `targetFile`, `path`) across backend normalization, frontend props, summaries, and grouped chat blocks. Do not add component-local `a || b || c` chains.
- Read-file rendering tests must cover single blocks, grouped `ReadFileGroup`, and aggregate `ActionSummaryGroup` summaries, including camelCase Cursor-style tool payloads.
- Multi-repo session launch tests must assert the selected durable repo path in the launch payload/runtime snapshot, and separately assert that UI search/source badges remain accurate for non-primary repos.
- Multi-root E2E setup helpers must not silently call single-repo pinning (`repoPath: E2E_REPO_PATH`, `ensureRepoSelected`, or equivalent) after seeding multiple folders. If a creator/helper needs account/model setup only, pass through the existing selected multi-root workspace and assert `workspaceFolders`/source evidence afterward.
- Multi-repo path-rendering tests must use self-contained fixture paths with colliding basenames and payload key variants (`targetFile`, `file_path`, nested `success.filePath`, etc.). Do not depend on another local checkout such as `claude_code`, and do not accept generic labels like `file` as path evidence.
- Multi-repo search tests must validate both the visible source badge and the selected path/pill value. A menu that merely contains two basenames is not enough; the chosen secondary repo result must survive click/keyboard selection into the composer context.
- When a multi-repo bug is fixed in one surface, sweep all equivalent surfaces: session creator, existing chat composer, context menu, event normalizer, props extraction, tool-call summary, grouped transcript rendering, and E2E seed helpers.
- Audit duplicate workspace state sources before adding patches. If both a canonical store path and an older/legacy workspace atom module exist, tests must import the production path and the diff must not add another derived source of truth.
- Any E2E helper that sets `activeFolder`, `selectedRepo`, `workspaceFolders`, or launch workspace fields must return a snapshot of all related atoms/paths and the test must assert the durable/active distinction immediately. If a failure message shows the target path inside the folder dump but matching failed, inspect argument marshaling and path normalization before adding fallback display logic.
- Do not fix multi-repo bugs with display-only band-aids. A valid fix names the data contract, centralizes extraction/resolution once, wires all consumers to that contract, and adds negative tests that would fail if a component-local fallback or single-repo pinning returned.

## Matrix evidence policy

For requested provider/runtime matrices, each row needs current-code evidence and a clear outcome.

- Record the exact account/model/runtime row, command/spec/scenario, and result (`PASS`, `BLOCKED`, or `FAIL`).
- A fallback due to Gemini 429/capacity may satisfy the user flow only if the row records the original provider block and the fallback model that actually produced evidence.
- Do not claim “9 matrix all green” from a subset run, a prior commit, or a combined fallback. Every row must produce independent evidence or be explicitly marked `BLOCKED` with provider/account reason.
- Matrix rows should reuse deterministic fake-provider/debug bridges for product invariants and reserve live-provider rows for integration smoke, otherwise provider flakiness hides product regressions.

## Workspace fixture policy

Core UI E2E must not depend on `yorg_frontend`, `yoyo-evolve`, or any external local project.

The WDIO runner creates a self-contained git fixture repo by default:

- Path: `/tmp/orgii-e2e-workspace-repo`
- Rebuilt at runner startup
- Contains `README.md`, `package.json`, `src/math.ts`, and an initial git commit
- Safe for agent mutation tests

Only set `E2E_REPO_PATH` when intentionally overriding with another sandbox git repo. The runner must reject explicit paths that do not exist, are not git repos, or lack the baseline files.

Session launch specs should pass the fixture `repoPath` through the same session configure/launch caller path the user uses. Do not add a separate `before` hook that only calls `ensureRepoSelected`; that helper can time out before the app is fully settled and can mask the real launch path with WebDriver harness failures.

Recommended isolated UI run when the developer app may already be using `1998`:

```bash
E2E_ISOLATED_RUN=1 \
E2E_ORGII_HOME="/tmp/orgii-e2e-home" \
E2E_FRONTEND_PORT=21998 \
E2E_WEBDRIVER_PORT=24444 \
E2E_IDE_SERVER_PORT=23847 \
npm test
```

WDIO managed runs must not kill or reuse a developer's active ORGII app by default. The runner should fail fast if its managed ports are occupied unless `E2E_ALLOW_PORT_CLEANUP=1` is explicitly set. When `E2E_FRONTEND_PORT` differs from `1998`, the WDIO runner must make that real by building the webdriver debug app against a temporary Tauri `devUrl` pointing at the requested port, then restoring `src-tauri/tauri.conf.json` exactly. Merely starting webpack on a non-1998 port is false isolation because an unpatched debug app still loads `http://localhost:1998`.
