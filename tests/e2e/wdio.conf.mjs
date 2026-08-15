import dotenv from "dotenv";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const appBinary = resolve(repoRoot, "src-tauri/target/debug/org2");

// Load tests/e2e/.env so specs can read OPENAI_API_KEY etc. via process.env.
// Quiet failure is fine — the .env is optional; without it, tests fall back to
// the weak "agent started processing" assertion.
dotenv.config({ path: resolve(__dirname, ".env"), quiet: true });

const specFileRetries = Number.parseInt(
  process.env.WDIO_SPEC_FILE_RETRIES ?? "0",
  10
);
const mochaTimeoutMs = Number.parseInt(
  process.env.WDIO_MOCHA_TIMEOUT_MS ?? "420000",
  10
);
const connectionRetryTimeoutMs = Number.parseInt(
  process.env.WDIO_CONNECTION_RETRY_TIMEOUT_MS ?? "30000",
  10
);
const connectionRetryCount = Number.parseInt(
  process.env.WDIO_CONNECTION_RETRY_COUNT ?? "10",
  10
);
const reuseServices = process.env.E2E_REUSE_SERVICES === "1";
const allowParallel = process.env.E2E_ALLOW_PARALLEL === "1";
const isolatedRun = process.env.E2E_ISOLATED_RUN === "1";
const allowPortCleanup = process.env.E2E_ALLOW_PORT_CLEANUP === "1";
const providerMode = process.env.E2E_PROVIDER_MODE ?? "mock";
const oauthLiveMode = providerMode === "oauth-live";
process.env.ORGII_E2E = "1";
process.env.ORGII_E2E_DISABLE_BACKGROUND_LLM ??= "1";

if (process.env.E2E_ALLOW_OAUTH_ROTATION_SEED === "1") {
  throw new Error(
    "E2E_ALLOW_OAUTH_ROTATION_SEED has been removed because cloning rotating OAuth chains can revoke user accounts. Use E2E_PROVIDER_MODE=mock/api-key, or E2E_PROVIDER_MODE=oauth-live with E2E_OAUTH_TEST_HOME."
  );
}

if (oauthLiveMode) {
  if (!process.env.E2E_OAUTH_TEST_HOME) {
    throw new Error(
      "E2E_PROVIDER_MODE=oauth-live requires E2E_OAUTH_TEST_HOME so the test owns a dedicated OAuth home."
    );
  }
  if (allowParallel) {
    throw new Error(
      "E2E_ALLOW_PARALLEL=1 is forbidden with E2E_PROVIDER_MODE=oauth-live"
    );
  }
  // Default seed source to real ~/.orgii so credentials are available.
  process.env.E2E_ORGII_HOME_SEED_SOURCE ??= join(homedir(), ".orgii");
  process.env.E2E_ORGII_HOME ??= process.env.E2E_OAUTH_TEST_HOME;
}
const webDriverPort = Number.parseInt(
  process.env.E2E_WEBDRIVER_PORT ?? "4444",
  10
);
const ideServerPort = Number.parseInt(
  process.env.E2E_IDE_SERVER_PORT ?? "13847",
  10
);
const TAURI_DEV_URL_PORT = 1998;
const frontendPort = Number.parseInt(
  process.env.E2E_FRONTEND_PORT ?? String(TAURI_DEV_URL_PORT),
  10
);
const tauriConfigPath = resolve(repoRoot, "src-tauri/tauri.conf.json");

if (allowParallel && !reuseServices) {
  throw new Error(
    "E2E_ALLOW_PARALLEL=1 is only supported with E2E_REUSE_SERVICES=1. Start one shared frontend/app stack explicitly, then run isolated WDIO workers against it."
  );
}

if (allowParallel || isolatedRun) {
  const missingPortVars = ["E2E_WEBDRIVER_PORT", "E2E_IDE_SERVER_PORT"].filter(
    (name) => !process.env[name]
  );
  if (missingPortVars.length > 0) {
    throw new Error(
      `isolated WDIO runs require explicit ports: ${missingPortVars.join(", ")}`
    );
  }
}

if (isolatedRun && !process.env.E2E_ORGII_HOME) {
  throw new Error("E2E_ISOLATED_RUN=1 requires E2E_ORGII_HOME");
}
const sourceOrgiiHome =
  process.env.E2E_ORGII_HOME_SEED_SOURCE ??
  (oauthLiveMode
    ? process.env.E2E_OAUTH_TEST_HOME
    : isolatedRun
      ? join(homedir(), ".orgii")
      : (process.env.ORGII_HOME ?? join(homedir(), ".orgii")));
// Isolation is the DEFAULT: non-isolated runs previously used the real
// ~/.orgii, which is how "E2E Custom Member Agent" fixtures leaked into
// the user's actual agent-definitions.json whenever a spec crashed
// before its finally-cleanup. Touching the real home now requires the
// explicit opt-in E2E_USE_REAL_HOME=1.
const useRealHome = process.env.E2E_USE_REAL_HOME === "1";
const orgiiHome =
  process.env.E2E_ORGII_HOME ??
  (useRealHome ? undefined : mkdtempSync(join(tmpdir(), "orgii-e2e-shard-")));

const ORGII_HOME_SEED_ENTRIES = [
  "agent-definitions.json",
  "agent-orgs.json",
  "builtin-overrides.json",
  "credentials.json",
  "data",
  "integrations.json",
  "mcp-servers.json",
  "personal",
  "projects",
  "rules",
  "rules-config.json",
  "settings.jsonc",
  "skills",
  "workspace-memory",
];
const ORGII_HOME_SECRET_SEED_ENTRIES = new Set([
  "auth_tokens.json",
  "claude-code-cli-profiles",
  "codex-cli-profiles",
  "cursor-cli-profiles",
]);
const ORGII_HOME_SEED_EXCLUDED_NAMES = new Set([
  ".cargo",
  ".rustup",
  ".tmp",
  "node_modules",
  "target",
  "tmp",
]);
const e2eMultiRepoWorkspace = process.env.E2E_MULTI_REPO_WORKSPACE === "1";
const fixtureRepoPath = resolve(
  process.env.E2E_FIXTURE_REPO_PATH ??
    (process.platform === "win32"
      ? join(tmpdir(), "orgii-e2e-workspace-repo")
      : "/tmp/orgii-e2e-workspace-repo")
);

function shouldSeedOrgiiHomePath(sourcePath) {
  return !sourcePath
    .split("/")
    .some((segment) => ORGII_HOME_SEED_EXCLUDED_NAMES.has(segment));
}

function seedOrgiiHomeForParallel(sourceHome, targetHome) {
  if (!(allowParallel || isolatedRun)) return;
  if (process.env.E2E_ORGII_HOME && !isolatedRun) return;
  if (resolve(sourceHome) === resolve(targetHome)) return;
  mkdirSync(targetHome, { recursive: true });
  for (const entry of ORGII_HOME_SEED_ENTRIES) {
    if (providerMode === "mock" && entry === "credentials.json") continue;
    if (ORGII_HOME_SECRET_SEED_ENTRIES.has(entry)) {
      throw new Error(
        `Refusing to seed OAuth/secret ORGII home entry into E2E home: ${entry}`
      );
    }
    const sourcePath = join(sourceHome, entry);
    if (!existsSync(sourcePath)) continue;
    const targetPath = join(targetHome, entry);
    cpSync(sourcePath, targetPath, {
      dereference: false,
      errorOnExist: false,
      filter: shouldSeedOrgiiHomePath,
      force: true,
      recursive: true,
    });
  }
}

function seedMockApiAccount(targetHome) {
  if (providerMode !== "mock" || !targetHome) return;
  const accountId = "e2ea0272";
  const accountName = "E2E Agent Org Mock";
  const model = "e2e-fake-provider-agent-org-ui";
  const now = new Date().toISOString();
  writeFileSync(
    join(targetHome, "credentials.json"),
    `${JSON.stringify(
      {
        credentials: {
          [accountId]: {
            account_metadata: {},
            agent_type: "openai_api",
            api_key: "e2e-fake-provider-key",
            auth_method: "api_key",
            available_models: [model],
            base_url: null,
            created_at: now,
            default_variants: [],
            description: null,
            enabled: true,
            enabled_models: [model],
            env_vars: {},
            has_local_key: true,
            health_status: "unknown",
            id: accountId,
            is_listed: false,
            last_oauth_refresh_failed_at: null,
            last_upstream_error_type: null,
            last_upstream_status: null,
            last_validated_at: null,
            last_validation_error: null,
            listing_id: null,
            model_aliases: [],
            model_variants: [],
            name: accountName,
            oauth_refresh_failure_count: 0,
            protocol: null,
            quota_info: null,
            rate_limit_reset_at: null,
            session_token: null,
            temporary_unavailable_reason: null,
            temporary_unavailable_until: null,
            updated_at: now,
          },
        },
        updated_at: now,
        version: "2.0",
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

// E2E hit-testing (elementFromPoint vs getBoundingClientRect) assumes
// zoom=1. The user's seeded settings may carry general.uiScale != 100,
// which WebKit renders via CSS zoom and breaks coordinate math in specs
// (clicks land on the wrong element). Normalize the isolated home's copy.
function normalizeUiScaleForIsolatedRun(targetHome) {
  if (!(allowParallel || isolatedRun) || !targetHome) return;
  const settingsPath = join(targetHome, "settings.jsonc");
  if (!existsSync(settingsPath)) return;
  const raw = readFileSync(settingsPath, "utf8");
  const patched = raw.replace(/("general\.uiScale"\s*:\s*)\d+/, "$1100");
  if (patched !== raw) writeFileSync(settingsPath, patched);
}

function resetDerivedProjectDatabaseForIsolatedRun(targetHome) {
  if (!isolatedRun || !targetHome) return;
  rmSync(join(targetHome, "projects", "projects.db"), {
    force: true,
    recursive: true,
  });
}

if (orgiiHome) {
  seedOrgiiHomeForParallel(sourceOrgiiHome, orgiiHome);
  seedMockApiAccount(orgiiHome);
  normalizeUiScaleForIsolatedRun(orgiiHome);
  resetDerivedProjectDatabaseForIsolatedRun(orgiiHome);
  process.env.ORGII_HOME = orgiiHome;
}

// External-history discovery (Claude Code / Codex / Cursor local transcript
// scanning) falls back to the real OS user home whenever this is unset. A
// managed WDIO run must never let that scan hit the developer's actual
// ~/.claude, ~/.codex, etc., and specs that want the app to discover a
// synthetic imported-history transcript need a known, writable root. Every
// managed run therefore gets an isolated external-history home, mirroring
// the `orgiiHome` isolation above.
const externalHistoryHome =
  process.env.ORGII_EXTERNAL_HISTORY_HOME ??
  mkdtempSync(join(tmpdir(), "orgii-e2e-external-history-"));
process.env.ORGII_EXTERNAL_HISTORY_HOME = externalHistoryHome;

// Claude Code imported-history fixture consumed by the
// "claude-imported-lazy-replay" scenario in chat-rendering-ui.spec.mjs. It
// must exist on disk before the app process launches so the app's own
// startup external-history auto-scan (`useDataSourceAutoScan`) discovers it
// without the spec needing a debug seed/mutation endpoint. Written here
// (mirroring `ensureE2EWorkspaceRepo`)
// rather than in the spec so it is guaranteed to land before
// `startTauriWebDriver()` runs below.
const CLAUDE_IMPORT_FIXTURE_UUID = "e2ec0de0-c0de-4000-8000-000000000001";
const CLAUDE_IMPORT_FIXTURE_SESSION_ID = `claudecodeapp-${CLAUDE_IMPORT_FIXTURE_UUID}`;
const CLAUDE_IMPORT_FIXTURE_ROUND_COUNT = 10;
const CLAUDE_IMPORT_FIXTURE_CWD = "/tmp/orgii-e2e-claude-import-fixture";

function claudeCodeImportFixtureTranscriptPath(home) {
  return join(
    home,
    ".claude",
    "projects",
    "e2e-claude-imported-lazy-replay",
    `${CLAUDE_IMPORT_FIXTURE_UUID}.jsonl`
  );
}

// Row shapes copied verbatim (field-for-field) from the fixtures in
// src-tauri/crates/orgtrack-core/src/sources/claude_code/history_tests.rs so
// the real Claude Code JSONL parser accepts this transcript unmodified.
//
// Timestamps are anchored to `baseMs` (real "now" at fixture-write time),
// not a fixed calendar date: the sidebar session list buckets rows by
// age (today/yesterday/thisWeek/older -- src/util/session/sessionDateBuckets.ts)
// and only eager-loads a bounded page per bucket. Keeping every round inside
// the "today" bucket avoids depending on that pagination/bucket-limit
// behavior just to make the fixture session visible.
function claudeCodeImportFixtureRoundLines(startRound, roundCount, baseMs) {
  const lines = [];
  for (let round = startRound; round < startRound + roundCount; round++) {
    const userAt = new Date(baseMs + round * 2_000).toISOString();
    const assistantAt = new Date(baseMs + round * 2_000 + 1_000).toISOString();
    lines.push(
      JSON.stringify({
        type: "user",
        sessionId: CLAUDE_IMPORT_FIXTURE_UUID,
        cwd: CLAUDE_IMPORT_FIXTURE_CWD,
        gitBranch: "main",
        timestamp: userAt,
        message: { role: "user", content: `round-${round} prompt` },
      })
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        sessionId: CLAUDE_IMPORT_FIXTURE_UUID,
        cwd: CLAUDE_IMPORT_FIXTURE_CWD,
        gitBranch: "main",
        timestamp: assistantAt,
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: `round-${round} answer body` }],
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      })
    );
  }
  return lines;
}

function ensureClaudeCodeImportFixtureTranscript() {
  const fixturePath = claudeCodeImportFixtureTranscriptPath(externalHistoryHome);
  mkdirSync(dirname(fixturePath), { recursive: true });
  // A few minutes in the past so every seeded round timestamp is safely
  // before "now" once the app actually reads this file.
  const baseMs = Date.now() - 5 * 60_000;
  const lines = claudeCodeImportFixtureRoundLines(
    1,
    CLAUDE_IMPORT_FIXTURE_ROUND_COUNT,
    baseMs
  );
  writeFileSync(fixturePath, `${lines.join("\n")}\n`, "utf8");
  process.env.E2E_CLAUDE_IMPORT_FIXTURE_SESSION_ID =
    CLAUDE_IMPORT_FIXTURE_SESSION_ID;
  process.env.E2E_CLAUDE_IMPORT_FIXTURE_PATH = fixturePath;
  process.env.E2E_CLAUDE_IMPORT_FIXTURE_ROUND_COUNT = String(
    CLAUDE_IMPORT_FIXTURE_ROUND_COUNT
  );
  process.env.E2E_CLAUDE_IMPORT_FIXTURE_CWD = CLAUDE_IMPORT_FIXTURE_CWD;
  return fixturePath;
}

process.env.ORGII_IDE_SERVER_PORT = String(ideServerPort);
process.env.E2E_BASE_URL =
  process.env.E2E_BASE_URL ?? `http://127.0.0.1:${ideServerPort}`;
ensureE2EWorkspaceRepo();
ensureClaudeCodeImportFixtureTranscript();

const WDIO_PRE_FLIGHT_PORTS = [webDriverPort, frontendPort, ideServerPort];
const WDIO_PRE_FLIGHT_PROCESS_PATTERNS = [
  "tauri-wd",
  "src-tauri/target/debug/org2",
];
let frontendServerProcess = null;
let tauriWebDriverProcess = null;

let oauthLiveLeasePath = null;

function acquireOAuthLiveLease() {
  if (!oauthLiveMode) return;
  const leaseDir = join(process.env.E2E_OAUTH_TEST_HOME, "e2e-oauth-locks");
  mkdirSync(leaseDir, { recursive: true });
  oauthLiveLeasePath = join(leaseDir, "oauth-live.lock");
  if (existsSync(oauthLiveLeasePath)) {
    const ownerPid = readFileSync(oauthLiveLeasePath, "utf8").trim();
    if (ownerPid && runBestEffort("kill", ["-0", ownerPid])) {
      throw new Error(
        `OAuth live E2E already owns the lease at ${oauthLiveLeasePath} with pid ${ownerPid}`
      );
    }
    rmSync(oauthLiveLeasePath, { force: true });
  }
  writeFileSync(oauthLiveLeasePath, `${process.pid}\n`);
}

function releaseOAuthLiveLease() {
  if (oauthLiveLeasePath) rmSync(oauthLiveLeasePath, { force: true });
}

// Mirror rotated credentials back to the source home so OAuth token
// rotations that happened during the E2E run are not lost.
function mirrorCredentialsBackToSource() {
  if (!oauthLiveMode) return;
  if (!orgiiHome || !sourceOrgiiHome) return;
  if (resolve(orgiiHome) === resolve(sourceOrgiiHome)) return;
  const isolatedCreds = join(orgiiHome, "credentials.json");
  const sourceCreds = join(sourceOrgiiHome, "credentials.json");
  if (!existsSync(isolatedCreds)) return;
  try {
    const isolatedRaw = readFileSync(isolatedCreds, "utf8");
    const sourceRaw = existsSync(sourceCreds)
      ? readFileSync(sourceCreds, "utf8")
      : "";
    if (isolatedRaw !== sourceRaw) {
      cpSync(isolatedCreds, sourceCreds, { force: true });
      console.log(
        `[wdio] mirror-back: credentials.json written back to ${sourceCreds}`
      );
    }
  } catch (error) {
    console.warn(
      `[wdio] mirror-back: failed to write credentials back: ${error?.message ?? error}`
    );
  }
}

function runBestEffort(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: "pipe",
      ...options,
    });
  } catch {
    return "";
  }
}

function isGitRepository(repoPath) {
  return runBestEffort("git", [
    "-C",
    repoPath,
    "rev-parse",
    "--is-inside-work-tree",
  ])
    .trim()
    .includes("true");
}

function verifyE2EWorkspaceRepo(repoPath) {
  if (!existsSync(repoPath)) {
    throw new Error(`E2E_REPO_PATH does not exist: ${repoPath}`);
  }
  if (!isGitRepository(repoPath)) {
    throw new Error(`E2E_REPO_PATH must be a git repository: ${repoPath}`);
  }
  const packagePath = join(repoPath, "package.json");
  const readmePath = join(repoPath, "README.md");
  if (!existsSync(packagePath) || !existsSync(readmePath)) {
    throw new Error(
      `E2E_REPO_PATH must contain package.json and README.md so workspace selection and CLI prompts are deterministic: ${repoPath}`
    );
  }
}

function createFixtureRepo(repoPath) {
  rmSync(repoPath, { force: true, recursive: true });
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(
    join(repoPath, "README.md"),
    [
      "# ORGII E2E Workspace Repo",
      "",
      "This repository is generated by the ORGII WDIO runner.",
      "It is intentionally small, non-empty, and safe for agent mutation tests.",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(repoPath, "package.json"),
    `${JSON.stringify(
      {
        name: "orgii-e2e-workspace-repo",
        private: true,
        type: "module",
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(repoPath, "src", "math.ts"),
    [
      "export function addNumbers(first: number, second: number): number {",
      "  return first + second;",
      "}",
      "",
    ].join("\n")
  );
  execFileSync("git", ["init", "--initial-branch=main", repoPath], {
    stdio: "ignore",
  });
  // Cross-device collaboration identifies workspaces by normalized remote,
  // never by local path. Give the deterministic fixture a harmless fake
  // origin so cloud share/fork E2E can exercise that production boundary.
  execFileSync(
    "git",
    [
      "-C",
      repoPath,
      "remote",
      "add",
      "origin",
      "https://github.com/orgii/e2e-workspace.git",
    ],
    { stdio: "ignore" }
  );
  execFileSync(
    "git",
    ["-C", repoPath, "add", "README.md", "package.json", "src/math.ts"],
    {
      stdio: "ignore",
    }
  );
  execFileSync(
    "git",
    [
      "-C",
      repoPath,
      "-c",
      "user.name=ORGII E2E",
      "-c",
      "user.email=e2e@orgii.local",
      "commit",
      "-m",
      "Initial E2E workspace",
    ],
    {
      stdio: "ignore",
    }
  );
  verifyE2EWorkspaceRepo(repoPath);
}

function createMultiRepoFixtureWorkspace(rootPath) {
  rmSync(rootPath, { force: true, recursive: true });
  const primaryRepoPath = join(rootPath, "primary-repo");
  const siblingRepoPath = join(rootPath, "sibling-repo");
  createFixtureRepo(primaryRepoPath);
  createFixtureRepo(siblingRepoPath);
  writeFileSync(
    join(siblingRepoPath, "src", "math.ts"),
    [
      "export function addNumbers(first: number, second: number): number {",
      "  return first - second;",
      "}",
      "",
      "export const SIBLING_ONLY_SENTINEL = 'ORGII_E2E_SIBLING_REPO';",
      "",
    ].join("\n")
  );
  execFileSync("git", ["-C", siblingRepoPath, "add", "src/math.ts"], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-C",
      siblingRepoPath,
      "-c",
      "user.name=ORGII E2E",
      "-c",
      "user.email=e2e@orgii.local",
      "commit",
      "-m",
      "Add sibling sentinel",
    ],
    { stdio: "ignore" }
  );
  return primaryRepoPath;
}

function ensureE2EWorkspaceRepo() {
  const explicitRepoPath = process.env.E2E_REPO_PATH;
  if (explicitRepoPath) {
    const repoPath = resolve(explicitRepoPath);
    verifyE2EWorkspaceRepo(repoPath);
    process.env.E2E_REPO_PATH = repoPath;
    return repoPath;
  }
  const repoPath = e2eMultiRepoWorkspace
    ? createMultiRepoFixtureWorkspace(fixtureRepoPath)
    : fixtureRepoPath;
  if (!e2eMultiRepoWorkspace) {
    createFixtureRepo(repoPath);
  }
  process.env.E2E_REPO_PATH = repoPath;
  return repoPath;
}

function killProcessIds(processIds) {
  const uniqueProcessIds = Array.from(new Set(processIds.filter(Boolean)));
  if (uniqueProcessIds.length === 0) return;
  runBestEffort("kill", ["-TERM", ...uniqueProcessIds]);
}

function processIdsForPort(port) {
  return runBestEffort("lsof", ["-ti", `tcp:${port}`])
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function processIdsForPattern(pattern) {
  return runBestEffort("pgrep", ["-f", pattern])
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((processId) => processId && processId !== String(process.pid));
}

function cleanWebDriverEnvironment() {
  if (!allowPortCleanup) return;
  const portsToClean =
    allowParallel || isolatedRun
      ? [webDriverPort, frontendPort, ideServerPort]
      : WDIO_PRE_FLIGHT_PORTS;
  const portProcessIds = portsToClean.flatMap(processIdsForPort);
  const staleProcessIds =
    allowParallel || isolatedRun
      ? []
      : WDIO_PRE_FLIGHT_PROCESS_PATTERNS.flatMap(processIdsForPattern);
  killProcessIds([...portProcessIds, ...staleProcessIds]);
}

function assertManagedPortsAvailable() {
  if (allowPortCleanup || reuseServices) return;
  const occupiedPorts = WDIO_PRE_FLIGHT_PORTS.filter(
    (port) => processIdsForPort(port).length > 0
  );
  if (occupiedPorts.length === 0) return;
  throw new Error(
    `Refusing to start managed WDIO while port(s) ${occupiedPorts.join(", ")} are in use. Close the running ORGII app first, or set E2E_ALLOW_PORT_CLEANUP=1 to let WDIO terminate stale processes.`
  );
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processIdsForPort(port).length > 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  throw new Error(`Port ${port} did not open within ${timeoutMs}ms`);
}

function startFrontendServer() {
  if (processIdsForPort(frontendPort).length > 0) return;
  frontendServerProcess = spawn("pnpm", ["run", "dev:frontend:light"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ORGII_E2E: "1",
      PORT: String(frontendPort),
      WEBPACK_DEV_SERVER_PORT: String(frontendPort),
    },
    stdio: "inherit",
  });
  waitForPort(frontendPort, 60_000);
}

function withTauriDevUrlForFrontendPort(callback) {
  if (frontendPort === TAURI_DEV_URL_PORT) return callback();
  const originalConfig = readFileSync(tauriConfigPath, "utf8");
  const config = JSON.parse(originalConfig);
  const patchedConfig = JSON.stringify(
    {
      ...config,
      build: {
        ...config.build,
        devUrl: `http://localhost:${frontendPort}`,
      },
    },
    null,
    2
  );
  writeFileSync(tauriConfigPath, `${patchedConfig}\n`);
  try {
    return callback();
  } finally {
    writeFileSync(tauriConfigPath, originalConfig);
  }
}

function buildWebDriverApp() {
  withTauriDevUrlForFrontendPort(() => {
    execFileSync(
      "cargo",
      [
        "build",
        "--manifest-path",
        resolve(repoRoot, "src-tauri/Cargo.toml"),
        "-p",
        "org2",
        "--features",
        "webdriver",
      ],
      { cwd: repoRoot, stdio: "inherit" }
    );
  });
}

function startTauriWebDriver() {
  tauriWebDriverProcess = spawn("tauri-wd", ["--port", String(webDriverPort)], {
    stdio: "inherit",
  });
  waitForPort(webDriverPort, 10_000);
}

function stopChildProcess(childProcess) {
  if (!childProcess) return;
  childProcess.kill("SIGTERM");
}

function stopTauriWebDriver() {
  stopChildProcess(tauriWebDriverProcess);
  tauriWebDriverProcess = null;
}

function stopFrontendServer() {
  stopChildProcess(frontendServerProcess);
  frontendServerProcess = null;
}

export const config = {
  runner: "local",
  specs: ["./specs/core/**/*.spec.mjs"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: webDriverPort,
  path: "/",
  capabilities: [
    {
      timeouts: {
        script: mochaTimeoutMs,
      },
      "tauri:options": {
        binary: appBinary,
      },
    },
  ],
  logLevel: process.env.WDIO_LOG_LEVEL ?? "warn",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: mochaTimeoutMs,
  },
  waitforTimeout: 30_000,
  connectionRetryTimeout: connectionRetryTimeoutMs,
  connectionRetryCount,
  // Keep webdriver-level retries bounded so no-window handshakes and hung
  // commands fail quickly instead of stalling the whole E2E run for minutes.
  automationProtocol: "webdriver",
  injectGlobals: true,
  onPrepare() {
    acquireOAuthLiveLease();
    if (reuseServices) return;
    assertManagedPortsAvailable();
    cleanWebDriverEnvironment();
    startFrontendServer();
    buildWebDriverApp();
    startTauriWebDriver();
  },
  before: async function () {
    await browser.setTimeout({ script: mochaTimeoutMs });
    await browser.waitUntil(
      async () => {
        try {
          await browser.executeScript(
            "window.localStorage.setItem(arguments[0], arguments[1]);",
            ["orgii:e2eBaseUrl", process.env.E2E_BASE_URL]
          );
          return true;
        } catch {
          return false;
        }
      },
      {
        timeout: 30_000,
        timeoutMsg: "E2E base URL could not be written to browser localStorage",
      }
    );
  },
  onComplete() {
    mirrorCredentialsBackToSource();
    releaseOAuthLiveLease();
    if (reuseServices) return;
    stopTauriWebDriver();
    stopFrontendServer();
  },
  // tauri-wd's getWindowHandle() occasionally races the WKWebView's first
  // paint on cold boot ("no window" WebDriverError within the first ~500ms).
  // Two retries swallow that handshake flake without hiding real failures.
  specFileRetries,
  specFileRetriesDelay: 3,
};
