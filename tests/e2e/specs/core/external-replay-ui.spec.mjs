/**
 * Dedicated rendered acceptance for Issue #443 bounded external replay.
 * It uses the production SessionCore/Tauri path against the real Codex
 * session selected by E2E_ISSUE_443_REAL_CODEX_SESSION_ID.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MOUNT_TIMEOUT_MS = 60_000;
const RUN_ID = Date.now();
const E2E_REPO_PATH =
  process.env.E2E_REPO_PATH ?? "/tmp/orgii-e2e-workspace-repo";
const ISSUE_443_REAL_CODEX_SESSION_ID =
  process.env.E2E_ISSUE_443_REAL_CODEX_SESSION_ID ?? "";
const ISSUE_443_FIXTURE_CODEX_SESSION_ID =
  process.env.E2E_ISSUE_443_FIXTURE_CODEX_SESSION_ID ?? "";
const MIB = 1024 * 1024;
const SCENARIO_FILTER = (process.env.E2E_CHAT_RENDERING_SCENARIOS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function shouldRunScenario(name) {
  return SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
}

function scenarioWasExplicitlyRequested(name) {
  return SCENARIO_FILTER.includes(name);
}

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function invokeTauriCommand(command, args = {}) {
  const envelope = await browser.executeAsyncScript(
    `
      const cb = arguments[arguments.length - 1];
      const command = arguments[0];
      const args = arguments[1];
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== "function") {
        cb({ ok: false, error: "Tauri invoke is unavailable" });
        return;
      }
      Promise.resolve(invoke(command, args))
        .then((result) => cb({ ok: true, result }))
        .catch((error) => cb({ ok: false, error: String(error?.message || error) }));
    `,
    [command, args]
  );
  if (envelope?.ok !== true) {
    throw new Error(
      `Tauri ${command} failed: ${envelope?.error ?? "unknown error"}`
    );
  }
  return envelope.result;
}

async function waitForFrontendReady() {
  const port = process.env.E2E_FRONTEND_PORT ?? "1998";
  const url = `http://127.0.0.1:${port}`;
  await browser.waitUntil(
    async () => {
      try {
        const response = await fetch(url, { method: "GET" });
        return response.ok;
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `frontend dev server never became ready at ${url}`,
    }
  );
}

async function invokeE2E(method, ...args) {
  return browser.executeAsyncScript(
    `
    const cb = arguments[arguments.length - 1];
    const method = arguments[0];
    const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
    if (!window.__e2e || typeof window.__e2e[method] !== "function") {
      cb({ ok: false, error: "window.__e2e." + method + " not available" });
      return;
    }
    Promise.resolve(window.__e2e[method].apply(null, rest))
      .then(cb)
      .catch((e) => cb({ ok: false, error: String(e && e.message || e) }));
  `,
    [method, ...args]
  );
}

async function invokeE2EDeferred(method, args, timeoutMs, label) {
  const key = `__orgiiE2EDeferred_${RUN_ID}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const started = await execJS(`
    const key = ${JSON.stringify(key)};
    const method = ${JSON.stringify(method)};
    const args = ${JSON.stringify(args)};
    if (!window.__e2e || typeof window.__e2e[method] !== "function") {
      return { ok: false, error: "window.__e2e." + method + " not available" };
    }
    const record = { state: "pending" };
    window[key] = record;
    Promise.resolve(window.__e2e[method].apply(null, args))
      .then((value) => {
        record.state = "fulfilled";
        record.value = value;
      })
      .catch((error) => {
        record.state = "rejected";
        record.error = String(error && (error.stack || error.message) || error);
      });
    return { ok: true };
  `);
  if (started?.ok !== true) {
    throw new Error(`${label} could not start: ${started?.error ?? "unknown"}`);
  }

  let envelope = null;
  try {
    await browser.waitUntil(
      async () => {
        envelope = await execJS(
          `return window[${JSON.stringify(key)}] ?? null;`
        );
        return (
          envelope?.state === "fulfilled" || envelope?.state === "rejected"
        );
      },
      {
        timeout: timeoutMs,
        interval: 500,
        timeoutMsg: `${label} did not finish within ${timeoutMs} ms`,
      }
    );
  } finally {
    await execJS(`delete window[${JSON.stringify(key)}];`);
  }

  if (envelope?.state === "rejected") {
    throw new Error(`${label} failed: ${envelope.error ?? "unknown"}`);
  }
  return envelope?.value;
}

async function waitForApp() {
  await waitForFrontendReady();
  await browser.setTimeout({ script: 5_000 });
  await execJS(`localStorage.setItem('orgii:auth_skipped', '1'); return true;`);
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return document.readyState === 'complete' || document.readyState === 'interactive';`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "app document never became script-readable",
    }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!document.querySelector('[data-testid="chat-panel"]');`
        );
      } catch {
        return false;
      }
    },
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "chat-panel never mounted" }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e && window.__e2e.seedChatEvents && window.__e2e.listAllTools);`
        );
      } catch {
        return false;
      }
    },
    { timeout: 20_000, timeoutMsg: "window.__e2e tool helpers never exposed" }
  );
}

async function assertIssue443RealCodexSessionStaysBounded() {
  if (!ISSUE_443_REAL_CODEX_SESSION_ID) {
    throw new Error(
      "E2E_ISSUE_443_REAL_CODEX_SESSION_ID is required for the real Codex acceptance scenario"
    );
  }

  // A real user reaches an imported session after the sidebar/data-source
  // scanner has indexed its source. Keep this setup on the production rescan
  // command so the open/release assertions below still exercise the real
  // bounded-replay adapter rather than relying on a pre-seeded test cache.
  await invokeTauriCommand("external_history_rescan_source", {
    source: "codex_app",
    clear: false,
  });

  const memoryBefore = await invokeTauriCommand("get_app_memory_snapshot_v1");
  const baselineBytes = Number(memoryBefore?.effective_total_bytes ?? 0);
  if (!(baselineBytes > 0)) {
    throw new Error(
      `native memory baseline is unavailable: ${JSON.stringify(memoryBefore)}`
    );
  }
  if (process.platform === "darwin") {
    if (memoryBefore.measurement !== "native") {
      throw new Error(
        `#435 regression: expected native macOS memory measurement, got ${memoryBefore.measurement}`
      );
    }
    let vmmapBytes = 0;
    for (const processRow of memoryBefore.processes ?? []) {
      if (processRow.metric_kind !== "physical_footprint") {
        throw new Error(
          `#435 regression: PID ${processRow.pid} used ${processRow.metric_kind}`
        );
      }
      const { stdout } = await execFileAsync(
        "/usr/bin/vmmap",
        ["-summary", String(processRow.pid)],
        { maxBuffer: 2 * MIB }
      );
      const match = stdout.match(
        /^Physical footprint:\s+([0-9.]+)\s*([KMGT]?)B?\s*$/im
      );
      if (!match) {
        throw new Error(
          `#435 regression: vmmap omitted Physical footprint for PID ${processRow.pid}`
        );
      }
      const units = { "": 1, K: 1024, M: MIB, G: 1024 * MIB, T: 1024 ** 4 };
      vmmapBytes += Number(match[1]) * units[match[2].toUpperCase()];
    }
    const difference = Math.abs(vmmapBytes - baselineBytes);
    const tolerance = Math.max(vmmapBytes * 0.1, 50 * MIB);
    if (difference > tolerance) {
      throw new Error(
        `#435 regression: native snapshot and vmmap differ by ${(difference / MIB).toFixed(1)} MiB (snapshot=${(baselineBytes / MIB).toFixed(1)} MiB, vmmap=${(vmmapBytes / MIB).toFixed(1)} MiB)`
      );
    }
    console.log(
      `[issue-443-real-codex] #435 native=${(baselineBytes / MIB).toFixed(1)} MiB vmmap=${(vmmapBytes / MIB).toFixed(1)} MiB diff=${(difference / MIB).toFixed(1)} MiB`
    );
  }

  // WebKit's allocator can retain several render passes before one pressure
  // cycle returns pages to the OS. Warm it with five real open/release passes,
  // then measure another five; a persistent leak cannot produce a low
  // post-release sample in that measured tail.
  const warmupCycles = 5;
  const measuredCycles = 5;
  const cycleCount = warmupCycles + measuredCycles;
  const samples = [];
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const startedAt = Date.now();
    const opened = await invokeE2EDeferred(
      "openSession",
      [ISSUE_443_REAL_CODEX_SESSION_ID],
      180_000,
      `real Codex open cycle ${cycle}`
    );
    if (!opened || opened.ok !== true) {
      throw new Error(
        `real Codex open cycle ${cycle} failed: ${opened?.error ?? "unknown"}`
      );
    }

    if (opened.sessionId !== ISSUE_443_REAL_CODEX_SESSION_ID) {
      throw new Error(
        `real Codex cycle ${cycle} opened the wrong session: ${opened.sessionId}`
      );
    }
    if (opened.eventCount > 200) {
      throw new Error(
        `real Codex cycle ${cycle} hydrated ${opened.eventCount} events; hard cap is 200`
      );
    }

    const memoryOpen = await invokeTauriCommand("get_app_memory_snapshot_v1");
    const openBytes = Number(memoryOpen?.effective_total_bytes ?? 0);
    const reset = await invokeE2E("resetToNewSession");
    if (!reset || reset.ok !== true) {
      throw new Error(
        `real Codex release cycle ${cycle} failed: ${reset?.error ?? "unknown"}`
      );
    }
    await browser.pause(1_000);
    const memoryReleased = await invokeTauriCommand(
      "get_app_memory_snapshot_v1"
    );
    samples.push({
      cycle,
      elapsedMs: Date.now() - startedAt,
      eventCount: opened.eventCount,
      openBytes,
      openProcesses: (memoryOpen?.processes ?? []).map((processRow) => ({
        pid: processRow.pid,
        role: processRow.role,
        mib: Number(
          (Number(processRow.effective_memory_bytes ?? 0) / MIB).toFixed(1)
        ),
      })),
      releasedBytes: Number(memoryReleased?.effective_total_bytes ?? 0),
      releasedProcesses: (memoryReleased?.processes ?? []).map(
        (processRow) => ({
          pid: processRow.pid,
          role: processRow.role,
          mib: Number(
            (Number(processRow.effective_memory_bytes ?? 0) / MIB).toFixed(1)
          ),
        })
      ),
    });
  }

  const firstGrowth = Math.max(0, samples[0].openBytes - baselineBytes);
  const steadyReference = samples[warmupCycles - 1].releasedBytes;
  const measuredTail = samples.slice(warmupCycles);
  // A one-second post-switch sample proves the foreground lifecycle released
  // its owners, but WebKit may return allocator pages to macOS later. Keep the
  // hard 250 MiB threshold and give the renderer one bounded idle window to
  // demonstrate that the high-water mark is reclaimable rather than live.
  const idleReleaseSamples = [];
  for (let sampleIndex = 0; sampleIndex < 6; sampleIndex += 1) {
    await browser.pause(5_000);
    const memoryIdle = await invokeTauriCommand("get_app_memory_snapshot_v1");
    idleReleaseSamples.push({
      elapsedMs: (sampleIndex + 1) * 5_000,
      releasedBytes: Number(memoryIdle?.effective_total_bytes ?? 0),
      releasedProcesses: (memoryIdle?.processes ?? []).map((processRow) => ({
        pid: processRow.pid,
        role: processRow.role,
        mib: Number(
          (Number(processRow.effective_memory_bytes ?? 0) / MIB).toFixed(1)
        ),
      })),
    });
  }
  const settledCandidates = [...measuredTail, ...idleReleaseSamples];
  const settledBytes = Math.min(
    ...settledCandidates.map((sample) => sample.releasedBytes)
  );
  const settledGrowth = Math.max(0, settledBytes - baselineBytes);
  const stepGrowth = Math.max(0, settledBytes - steadyReference);
  const backendMib = (sample) =>
    sample.releasedProcesses.find((processRow) => processRow.role === "backend")
      ?.mib ?? 0;
  const backendStepGrowthMib = Math.max(
    0,
    Math.min(...settledCandidates.map(backendMib)) -
      backendMib(samples[warmupCycles - 1])
  );
  console.log(
    `[issue-443-real-codex] baseline=${(baselineBytes / MIB).toFixed(1)} MiB firstGrowth=${(firstGrowth / MIB).toFixed(1)} MiB settledGrowth=${(settledGrowth / MIB).toFixed(1)} MiB measuredStepGrowth=${(stepGrowth / MIB).toFixed(1)} MiB backendStepGrowth=${backendStepGrowthMib.toFixed(1)} MiB samples=${JSON.stringify(samples)} idleSamples=${JSON.stringify(idleReleaseSamples)}`
  );
  if (firstGrowth > 400 * MIB) {
    throw new Error(
      `real Codex first open grew Physical Footprint by ${(firstGrowth / MIB).toFixed(1)} MiB`
    );
  }
  if (stepGrowth > 64 * MIB) {
    throw new Error(
      `five measured real Codex open/release cycles grew another ${(stepGrowth / MIB).toFixed(1)} MiB after warmup`
    );
  }
  if (settledGrowth > 250 * MIB) {
    throw new Error(
      `real Codex settled Physical Footprint remained ${(settledGrowth / MIB).toFixed(1)} MiB above baseline`
    );
  }
  if (backendStepGrowthMib > 16) {
    throw new Error(
      `five measured real Codex cycles grew backend Physical Footprint by ${backendStepGrowthMib.toFixed(1)} MiB`
    );
  }
}

async function assertFixtureCodexSessionUsesBoundedReplay() {
  if (!ISSUE_443_FIXTURE_CODEX_SESSION_ID) {
    throw new Error(
      "The isolated external-replay fixture was not configured by the WDIO harness"
    );
  }
  await invokeTauriCommand("external_history_rescan_source", {
    source: "codex_app",
    clear: false,
  });
  const beforeCounts = await execJS(
    "return { ...(window.__orgiiE2ERpcCounts || {}) };"
  );
  const opened = await invokeE2E(
    "openSession",
    ISSUE_443_FIXTURE_CODEX_SESSION_ID
  );
  if (!opened || opened.ok !== true) {
    throw new Error(
      `fixture Codex open failed: ${opened?.error ?? "unknown error"}`
    );
  }
  if (opened.sessionId !== ISSUE_443_FIXTURE_CODEX_SESSION_ID) {
    throw new Error(`fixture opened the wrong session: ${opened.sessionId}`);
  }
  if (!(opened.eventCount > 0 && opened.eventCount <= 200)) {
    throw new Error(
      `fixture hydrated ${opened.eventCount} events; expected 1..200`
    );
  }
  await browser.waitUntil(
    async () =>
      Boolean(
        await execJS(
          `return document.body.innerText.includes("E2E bounded replay fixture final answer");`
        )
      ),
    {
      timeout: 20_000,
      timeoutMsg: "bounded Codex fixture answer never rendered",
    }
  );
  const afterOpenCounts = await execJS(
    "return { ...(window.__orgiiE2ERpcCounts || {}) };"
  );
  const replayOpenCalls =
    Number(afterOpenCounts.external_replay_open_window ?? 0) -
    Number(beforeCounts.external_replay_open_window ?? 0);
  if (replayOpenCalls < 1) {
    throw new Error(
      "fixture session did not enter the production external_replay_open_window path"
    );
  }
  const reset = await invokeE2E("resetToNewSession");
  if (!reset || reset.ok !== true) {
    throw new Error(
      `fixture Codex release failed: ${reset?.error ?? "unknown error"}`
    );
  }
  await browser.waitUntil(
    async () => {
      const counts = await execJS(
        "return { ...(window.__orgiiE2ERpcCounts || {}) };"
      );
      return (
        Number(counts.external_replay_release ?? 0) >
        Number(afterOpenCounts.external_replay_release ?? 0)
      );
    },
    {
      timeout: 10_000,
      timeoutMsg: "fixture session never released its replay lease",
    }
  );
}

describe("External replay rendered UI", () => {
  before(async () => {
    await waitForApp();
    const repo = await invokeE2E("ensureRepoSelected", {
      repoPath: E2E_REPO_PATH,
      repoName: "E2E Fixture Repo",
    });
    if (!repo || repo.ok !== true) {
      throw new Error(`ensureRepoSelected failed: ${repo?.error ?? "unknown"}`);
    }
    const navigation = await invokeE2E("navigateTo", "/orgii/workstation/code");
    if (!navigation || navigation.ok !== true) {
      throw new Error(`navigateTo failed: ${navigation?.error ?? "unknown"}`);
    }
  });

  it("opens the isolated Codex fixture through bounded external replay", async function () {
    if (!shouldRunScenario("issue-443-fixture-codex")) {
      this.skip();
      return;
    }
    if (!ISSUE_443_FIXTURE_CODEX_SESSION_ID) {
      if (scenarioWasExplicitlyRequested("issue-443-fixture-codex")) {
        throw new Error(
          "issue-443-fixture-codex was explicitly requested without the isolated fixture"
        );
      }
      this.skip();
      return;
    }

    await assertFixtureCodexSessionUsesBoundedReplay();
  });

  it("opens and releases the real #443 Codex session without full hydration or staircase growth", async function () {
    if (!shouldRunScenario("issue-443-real-codex")) {
      this.skip();
      return;
    }
    if (!ISSUE_443_REAL_CODEX_SESSION_ID) {
      if (scenarioWasExplicitlyRequested("issue-443-real-codex")) {
        throw new Error(
          "E2E_ISSUE_443_REAL_CODEX_SESSION_ID is required when issue-443-real-codex is explicitly requested"
        );
      }
      this.skip();
      return;
    }

    await assertIssue443RealCodexSessionStaysBounded();
  });
});
