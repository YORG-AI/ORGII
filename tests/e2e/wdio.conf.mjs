import dotenv from "dotenv";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { seedSidebarCursorFixtures } from "./support/core/sidebarCursorFixtures.mjs";
import {
  assertSidebarFixtureRoot,
  prepareSidebarFixtureRoot,
} from "./support/core/sidebarFixtureIsolation.mjs";

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
if (
  process.argv.some((value) =>
    value.includes("sidebar-session-discovery-ui.spec.mjs")
  )
) {
  process.env.E2E_SIDEBAR_DISCOVERY_EXPLICIT = "1";
}
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

function seedBoundedExternalReplayFixture(targetHome) {
  assertSidebarFixtureRoot(targetHome);
  const sourceSessionId =
    "rollout-2026-07-25T00-00-00-00000000-0000-4000-8000-000000000443";
  const sessionsDir = join(
    targetHome,
    ".codex",
    "sessions",
    "2026",
    "07",
    "25"
  );
  const transcriptPath = join(sessionsDir, `${sourceSessionId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  const rows = [];
  // Keep the large replay and the 20 sidebar catalog rows in one local date
  // bucket. The imported-history loader intentionally fetches a bounded page
  // per bucket; crossing midnight here would test 1+10 bucket fan-out rather
  // than the category's 10→20→21 Load more contract.
  const baseTimestamp = Date.parse("2026-07-25T12:00:00Z");
  const largePayloadPrefix = "E2E bounded replay large payload start\n";
  const largePayloadSuffix = "\nE2E bounded replay large payload end";
  const largePayloadBytes = 6 * 1024 * 1024;
  const largePayload =
    largePayloadPrefix +
    "x".repeat(
      largePayloadBytes -
        Buffer.byteLength(largePayloadPrefix) -
        Buffer.byteLength(largePayloadSuffix)
    ) +
    largePayloadSuffix;
  let rowIndex = 0;
  const pushRow = (type, payload) => {
    rows.push({
      timestamp: new Date(baseTimestamp + rowIndex * 1_000).toISOString(),
      type,
      payload,
    });
    rowIndex += 1;
  };

  // Fifteen turns exceed ChatHistory's four-row virtualizer overscan. This
  // makes the rendered acceptance fail when selecting an unloaded early round
  // only materializes its DOM without actually scrolling it into the viewport.
  for (let turnIndex = 0; turnIndex < 15; turnIndex += 1) {
    const roundNumber = String(turnIndex + 1).padStart(2, "0");
    const question =
      turnIndex === 0
        ? "E2E bounded replay fixture question"
        : turnIndex === 12
          ? "E2E bounded replay fixture earlier question"
          : turnIndex === 13
            ? "E2E bounded replay fixture middle question"
            : turnIndex === 14
              ? "E2E bounded replay fixture latest question"
              : `E2E bounded replay fixture history turn ${roundNumber} question`;
    pushRow("event_msg", { type: "user_message", message: question });

    if (turnIndex === 13) {
      pushRow("response_item", {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command: "printf middle-marker" }),
        call_id: "e2e-middle-call",
      });
      pushRow("response_item", {
        type: "function_call_output",
        call_id: "e2e-middle-call",
        // A real >4 MiB JSONL payload pins the production payload-ref/range
        // path. If the ordinary replay window ever hydrates this body again,
        // the rendered test fails at the 4 MiB wire budget before it can claim
        // a green user flow.
        output: largePayload,
      });
    }

    const answer =
      turnIndex === 0
        ? "E2E bounded replay fixture answer"
        : turnIndex === 12
          ? "E2E bounded replay fixture earlier answer"
          : turnIndex === 13
            ? [
                "E2E bounded replay fixture middle answer",
                ...Array.from(
                  { length: 80 },
                  (_, index) =>
                    `Rendered scroll fixture detail ${String(index + 1).padStart(2, "0")}: bounded history remains readable.`
                ),
              ].join("\n\n")
            : turnIndex === 14
              ? "E2E bounded replay fixture final answer"
              : `E2E bounded replay fixture history turn ${roundNumber} answer`;
    pushRow("event_msg", { type: "agent_message", message: answer });
  }
  writeFileSync(
    transcriptPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8"
  );
  const transcriptUpdatedAtMs = baseTimestamp + rowIndex * 1_000;
  utimesSync(
    transcriptPath,
    new Date(transcriptUpdatedAtMs),
    new Date(transcriptUpdatedAtMs)
  );
  process.env.E2E_ISSUE_443_FIXTURE_CODEX_SESSION_ID = `codexapp-${sourceSessionId}`;
  process.env.E2E_ISSUE_443_FIXTURE_LARGE_PAYLOAD_BYTES = String(
    Buffer.byteLength(largePayload)
  );
  process.env.E2E_ISSUE_443_FIXTURE_LARGE_PAYLOAD_SHA256 = createHash("sha256")
    .update(largePayload)
    .digest("hex");
  process.env.E2E_ISSUE_443_FIXTURE_JSONL_BYTES = String(
    statSync(transcriptPath).size
  );

  const fixtures = [
    {
      sessionId: `codexapp-${sourceSessionId}`,
      sourceSessionId,
      title: "E2E bounded replay fixture question",
      marker: "E2E bounded replay fixture final answer",
      updatedAtMs: transcriptUpdatedAtMs,
      largePayload: true,
      searchSentinel: false,
    },
  ];
  const catalogBaseTimestamp = Date.parse("2026-07-25T10:00:00Z");
  const catalogSessionsDir = join(
    targetHome,
    ".codex",
    "sessions",
    "2026",
    "07",
    "25"
  );
  mkdirSync(catalogSessionsDir, { recursive: true });
  for (let index = 1; index <= 20; index += 1) {
    const suffix = String(index).padStart(12, "0");
    const minute = String(index).padStart(2, "0");
    const fixtureTimestamp = catalogBaseTimestamp + index * 60_000;
    const fixtureSourceSessionId =
      `rollout-2026-07-25T10-${minute}-00-` +
      `00000000-0000-4000-8000-${suffix}`;
    const title =
      index === 1
        ? "E2E Sidebar Codex Search Sentinel"
        : `E2E Sidebar Codex Architecture Review ${String(index).padStart(2, "0")}`;
    const marker = `E2E Sidebar Codex response ${String(index).padStart(2, "0")}`;
    const fixtureRows = [
      {
        timestamp: new Date(fixtureTimestamp).toISOString(),
        type: "event_msg",
        payload: { type: "user_message", message: title },
      },
      {
        timestamp: new Date(fixtureTimestamp + 1_000).toISOString(),
        type: "event_msg",
        payload: { type: "agent_message", message: marker },
      },
    ];
    const fixturePath = join(
      catalogSessionsDir,
      `${fixtureSourceSessionId}.jsonl`
    );
    writeFileSync(
      fixturePath,
      `${fixtureRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8"
    );
    utimesSync(
      fixturePath,
      new Date(fixtureTimestamp + 1_000),
      new Date(fixtureTimestamp + 1_000)
    );
    fixtures.push({
      sessionId: `codexapp-${fixtureSourceSessionId}`,
      sourceSessionId: fixtureSourceSessionId,
      title,
      marker,
      updatedAtMs: fixtureTimestamp + 1_000,
      largePayload: false,
      searchSentinel: index === 1,
    });
  }
  process.env.E2E_SIDEBAR_CODEX_FIXTURES = JSON.stringify(fixtures);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function seedSidebarOpenCodeFixtures(targetHome) {
  assertSidebarFixtureRoot(targetHome);
  const openCodeDir = join(targetHome, ".local", "share", "opencode");
  const dbPath = join(openCodeDir, "opencode.db");
  mkdirSync(openCodeDir, { recursive: true });
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });

  const fixtures = [];
  const statements = [
    "PRAGMA journal_mode=WAL;",
    `CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      model TEXT,
      tokens_input INTEGER NOT NULL,
      tokens_output INTEGER NOT NULL,
      tokens_reasoning INTEGER NOT NULL,
      tokens_cache_read INTEGER NOT NULL,
      tokens_cache_write INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      parent_id TEXT
    );`,
    `CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL
    );`,
    `CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      time_created INTEGER NOT NULL
    );`,
  ];
  const baseTimestamp = Date.parse("2026-07-25T12:00:00Z");
  for (let index = 1; index <= 21; index += 1) {
    const ordinal = String(index).padStart(2, "0");
    const sourceSessionId = `ses_e2e_sidebar_${ordinal}`;
    const sessionId = `opencodeapp-${sourceSessionId}`;
    const title = `E2E Sidebar OpenCode Dependency Review ${ordinal}`;
    const marker = `E2E Sidebar OpenCode response ${ordinal}`;
    const createdAt = baseTimestamp + index * 60_000;
    const updatedAt = createdAt + 5_000;
    const userMessageId = `msg_e2e_sidebar_user_${ordinal}`;
    const assistantMessageId = `msg_e2e_sidebar_assistant_${ordinal}`;
    fixtures.push({
      sessionId,
      sourceSessionId,
      title,
      marker,
      updatedAtMs: updatedAt,
    });
    statements.push(
      `INSERT INTO session (
        id, title, directory, model, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write,
        time_created, time_updated, time_archived, parent_id
      ) VALUES (
        ${sqlLiteral(sourceSessionId)},
        ${sqlLiteral(title)},
        ${sqlLiteral(fixtureRepoPath)},
        ${sqlLiteral(
          JSON.stringify({
            id: "e2e-opencode",
            providerID: "e2e",
            variant: "test",
          })
        )},
        10, 20, 0, 0, 0, ${createdAt}, ${updatedAt}, NULL, NULL
      );`,
      `INSERT INTO message (id, session_id, data) VALUES (
        ${sqlLiteral(userMessageId)},
        ${sqlLiteral(sourceSessionId)},
        ${sqlLiteral(
          JSON.stringify({ role: "user", time: { created: createdAt } })
        )}
      );`,
      `INSERT INTO message (id, session_id, data) VALUES (
        ${sqlLiteral(assistantMessageId)},
        ${sqlLiteral(sourceSessionId)},
        ${sqlLiteral(
          JSON.stringify({
            role: "assistant",
            modelID: "e2e-opencode",
          })
        )}
      );`,
      `INSERT INTO part (
        id, message_id, session_id, data, time_created
      ) VALUES (
        ${sqlLiteral(`prt_e2e_sidebar_user_${ordinal}`)},
        ${sqlLiteral(userMessageId)},
        ${sqlLiteral(sourceSessionId)},
        ${sqlLiteral(JSON.stringify({ type: "text", text: title }))},
        ${createdAt + 1}
      );`,
      `INSERT INTO part (
        id, message_id, session_id, data, time_created
      ) VALUES (
        ${sqlLiteral(`prt_e2e_sidebar_assistant_${ordinal}`)},
        ${sqlLiteral(assistantMessageId)},
        ${sqlLiteral(sourceSessionId)},
        ${sqlLiteral(JSON.stringify({ type: "text", text: marker }))},
        ${createdAt + 2}
      );`
    );
  }
  execFileSync("/usr/bin/sqlite3", [dbPath], {
    encoding: "utf8",
    input: `${statements.join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.env.E2E_SIDEBAR_OPENCODE_FIXTURES = JSON.stringify(fixtures);
}

// The default rendered suite must exercise an actual external-history driver
// without scanning or mutating the developer's real CLI homes. Explicit real
// Issue 272 runs opt back into the real home with their session id.
const realIssue443SessionConfigured = Boolean(
  process.env.E2E_ISSUE_443_REAL_CODEX_SESSION_ID
);
let externalProviderHome = null;
if (
  orgiiHome &&
  !reuseServices &&
  !useRealHome &&
  !realIssue443SessionConfigured &&
  !process.env.ORGII_EXTERNAL_HISTORY_HOME
) {
  externalProviderHome = prepareSidebarFixtureRoot({
    orgiiHome,
    candidateHome:
      process.env.E2E_EXTERNAL_PROVIDER_HOME ??
      join(
        orgiiHome,
        `external-provider-home-${process.pid}-${Date.now().toString(36)}`
      ),
    realUserHome: homedir(),
  });
  process.env.ORGII_EXTERNAL_HISTORY_HOME = externalProviderHome;
  seedBoundedExternalReplayFixture(externalProviderHome);
  seedSidebarOpenCodeFixtures(externalProviderHome);
  seedSidebarCursorFixtures(externalProviderHome);
  process.env.E2E_SIDEBAR_DISCOVERY_FIXTURE_READY = "1";
}

function ensureBenchmarkDockerFixtureRepo() {
  if (process.env.ORGII_SWE_BENCH_PRO_REPO_PATH) return;
  const fixtureRoot = join(tmpdir(), "orgii-e2e-swe-bench-pro-fixture");
  const runScriptsDir = join(fixtureRoot, "run_scripts", "e2e_docker_task");
  mkdirSync(runScriptsDir, { recursive: true });
  writeFileSync(
    join(fixtureRoot, "swe_bench_pro_eval.py"),
    `#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--raw_sample_path", required=True)
parser.add_argument("--patch_path", required=True)
parser.add_argument("--output_dir", required=True)
parser.add_argument("--scripts_dir", required=True)
parser.add_argument("--dockerhub_username")
parser.add_argument("--use_local_docker", action="store_true")
parser.add_argument("--num_workers", default="1")
args = parser.parse_args()

with open(args.patch_path, "r", encoding="utf-8") as handle:
    patch_rows = json.load(handle)
task_id = patch_rows[0]["instance_id"]
command = ["docker", "run", "--rm", "alpine:3.20", "sh", "-lc", "echo orgii-docker-benchmark-e2e"]
print("running docker command:", " ".join(command), flush=True)
completed = subprocess.run(command, text=True, capture_output=True)
print(completed.stdout, end="", flush=True)
if completed.stderr:
    print(completed.stderr, end="", file=sys.stderr, flush=True)
os.makedirs(args.output_dir, exist_ok=True)
with open(os.path.join(args.output_dir, "eval_results.json"), "w", encoding="utf-8") as handle:
    json.dump({task_id: completed.returncode == 0 and "orgii-docker-benchmark-e2e" in completed.stdout}, handle)
sys.exit(completed.returncode)
`,
    "utf8"
  );
  writeFileSync(
    join(runScriptsDir, "run_script.sh"),
    "#!/usr/bin/env bash\necho e2e run script\n",
    "utf8"
  );
  writeFileSync(
    join(runScriptsDir, "parser.py"),
    "print('e2e parser')\n",
    "utf8"
  );
  process.env.ORGII_SWE_BENCH_PRO_REPO_PATH = fixtureRoot;
}

process.env.ORGII_IDE_SERVER_PORT = String(ideServerPort);
process.env.E2E_BASE_URL =
  process.env.E2E_BASE_URL ?? `http://127.0.0.1:${ideServerPort}`;
ensureE2EWorkspaceRepo();
ensureBenchmarkDockerFixtureRepo();

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
    env: externalProviderHome
      ? {
          ...process.env,
          // Only tauri-wd and the ORGII child inherit this HOME. The WDIO
          // launcher keeps its real HOME, while provider discovery is forced
          // into a disposable tree containing only the deterministic fixtures.
          HOME: externalProviderHome,
          XDG_CONFIG_HOME: join(externalProviderHome, ".config"),
          XDG_DATA_HOME: join(externalProviderHome, ".local", "share"),
          XDG_CACHE_HOME: join(externalProviderHome, ".cache"),
          XDG_STATE_HOME: join(externalProviderHome, ".local", "state"),
          ORGII_EXTERNAL_HISTORY_HOME: externalProviderHome,
          ORGII_HOME: orgiiHome,
        }
      : process.env,
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
