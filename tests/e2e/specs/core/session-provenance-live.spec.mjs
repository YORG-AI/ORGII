/* global describe, before, it, browser */
/**
 * LIVE-LLM coverage for Session Provenance.
 *
 * Real Claude Code, Codex, and Cursor tools interact with one file through
 * production hooks. The scenario proves canonical storage, privacy filtering,
 * historical reconciliation, root/subagent transcript navigation, and sidebar
 * reveal using rendered UI and real pointer input.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  execJS,
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const RUN_ID = Date.now();
const LIVE_CLI_TIMEOUT_MS = 300_000;
const SENTINEL = `SESSION_PROVENANCE_BASE_${RUN_ID}`;
const CLAUDE_SENTINEL = `CLAUDE_PROVENANCE_${RUN_ID}`;
const CODEX_SENTINEL = `CODEX_PROVENANCE_${RUN_ID}`;
const CURSOR_SENTINEL = `CURSOR_PROVENANCE_${RUN_ID}`;
const TARGET_FILE = `session-provenance-live-${RUN_ID}.ts`;

function execFileWithClosedStdin(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    // Codex 0.144 reads piped stdin even when PROMPT is positional, appending
    // it as a <stdin> block. Node keeps this pipe open unless we close it,
    // which otherwise leaves `codex exec` waiting forever before its turn.
    child.stdin?.end();
  });
}

async function pointerClick(selector, label, timeout = 60_000) {
  let point = null;
  await browser.waitUntil(
    async () => {
      point = await browser.executeScript(
        `
          const selector = arguments[0];
          const candidates = [...document.querySelectorAll(selector)].filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
          const element = candidates[candidates.length - 1] ?? null;
          if (!element) return { ok: false, reason: "missing", selector };
          element.scrollIntoView({ block: "center", inline: "center" });
          const rect = element.getBoundingClientRect();
          const x = Math.floor(rect.left + rect.width / 2);
          const y = Math.floor(rect.top + rect.height / 2);
          const hit = document.elementFromPoint(x, y);
          return {
            ok: hit === element || Boolean(hit?.closest?.(selector)),
            selector,
            x,
            y,
            hit: hit?.getAttribute?.("data-testid") ?? hit?.tagName ?? null,
          };
        `,
        [selector]
      );
      return point?.ok === true;
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${label} not pointer-clickable: ${JSON.stringify(point)}`,
    }
  );
  await browser
    .action("pointer")
    .move({ x: point.x, y: point.y })
    .down()
    .up()
    .perform();
}

async function visibleSidebarSessionSnapshot(sessionId) {
  return execJS(`
    const sessionId = ${JSON.stringify(sessionId)};
    const row = [...document.querySelectorAll('[data-menu-item-id]')]
      .filter((candidate) => candidate.getAttribute('data-menu-item-id') === sessionId)
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
    if (!row) return { present: false, sessionId };
    const section = row.closest('[data-sidebar-section-id]');
    const sectionId = section?.getAttribute('data-sidebar-section-id') ?? null;
    const sectionToggle = section?.querySelector('[data-sidebar-section-toggle]');
    const scrollContainer = row.closest('.sidebar-list');
    const rowRect = row.getBoundingClientRect();
    const scrollRect = scrollContainer?.getBoundingClientRect();
    return {
      present: true,
      sessionId,
      selected: row.getAttribute('data-selected') === 'true',
      sectionId,
      sectionExpanded: sectionToggle?.getAttribute('aria-expanded') === 'true',
      withinScrollViewport: scrollRect
        ? rowRect.top >= scrollRect.top - 1 && rowRect.bottom <= scrollRect.bottom + 1
        : false,
      sidebarCollapsed: Boolean(row.closest('[data-sidebar-collapsed="true"]')),
    };
  `);
}

async function collapseSidebarSection(sectionId) {
  const selector = `[data-sidebar-section-toggle="${sectionId}"]`;
  const expanded = await execJS(`
    return [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })
      .some((candidate) => candidate.getAttribute('aria-expanded') === 'true');
  `);
  if (!expanded) return;
  await pointerClick(selector, `collapse sidebar section ${sectionId}`);
  await browser.waitUntil(
    async () =>
      execJS(`
        return [...document.querySelectorAll(${JSON.stringify(selector)})]
          .filter((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .some((candidate) => candidate.getAttribute('aria-expanded') === 'false');
      `),
    {
      timeout: 10_000,
      interval: 250,
      timeoutMsg: `sidebar section ${sectionId} did not collapse`,
    }
  );
}

async function visibleChatTranscriptSnapshot() {
  return execJS(`
    const roots = [...document.querySelectorAll('[data-chat-view-root]')];
    const root = roots.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }) ?? null;
    const transcript = root?.querySelector('[data-testid="chat-message-list"]') ?? null;
    return {
      sessionId: root?.getAttribute('data-session-id') ?? null,
      text: (transcript?.innerText || transcript?.textContent || '').trim(),
      historyCount: Number(transcript?.getAttribute('data-chat-history-count') || '0'),
    };
  `);
}

function hookConfigContainsMarker(path) {
  return (
    existsSync(path) &&
    readFileSync(path, "utf8").includes("--session-provenance-hook")
  );
}

function hookConfigContainsEvents(path, eventNames) {
  if (!existsSync(path)) return false;
  const config = JSON.parse(readFileSync(path, "utf8"));
  return eventNames.every(
    (eventName) =>
      Array.isArray(config?.hooks?.[eventName]) &&
      config.hooks[eventName].some((entry) => {
        const commands = [
          entry,
          ...(Array.isArray(entry?.hooks) ? entry.hooks : []),
        ];
        return commands.some((hook) =>
          String(hook?.command ?? hook?.commandWindows ?? "").includes(
            "--session-provenance-hook"
          )
        );
      })
  );
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function provenanceRowsForFile(orgiiHome, filePath) {
  const databasePath = join(orgiiHome, "sessions.db");
  if (!existsSync(databasePath)) return [];
  const sql = `
    SELECT interaction.session_id AS sessionId,
           interaction.source AS source,
           interaction.action AS action,
           interaction.turn_id AS turnId,
           interaction.actor_id AS actorId,
           interaction.capture_method AS captureMethod,
           interaction.attribution_precision AS attributionPrecision,
           interaction.payload_json AS payload
    FROM orgtrack_core_resource_interactions interaction
    JOIN orgtrack_core_file_resources file_resource
      ON file_resource.resource_id = interaction.resource_id
    WHERE file_resource.repo_relative_path = ${sqlLiteral(filePath)}
    ORDER BY interaction.occurred_at ASC;
  `;
  const { stdout } = await execFileWithClosedStdin(
    "sqlite3",
    ["-json", databasePath, sql],
    {
      maxBuffer: 2 * 1024 * 1024,
    }
  );
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function codexActorRows(orgiiHome, rootThreadId) {
  const databasePath = join(orgiiHome, "sessions.db");
  if (!existsSync(databasePath)) return [];
  const sql = `
    SELECT session_id AS sessionId,
           turn_id AS turnId,
           actor_id AS actorId,
           actor_type AS actorType,
           transcript_session_id AS transcriptSessionId,
           transcript_path AS transcriptPath,
           started_at AS startedAt,
           stopped_at AS stoppedAt
    FROM orgtrack_core_session_actors
    WHERE source = 'codex_app'
      AND session_id LIKE ${sqlLiteral(`%${rootThreadId}`)}
    ORDER BY COALESCE(stopped_at, started_at, '') ASC;
  `;
  const { stdout } = await execFileWithClosedStdin(
    "sqlite3",
    ["-json", databasePath, sql],
    { maxBuffer: 2 * 1024 * 1024 }
  );
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function runClaudeCodeProvenance(repoPath) {
  const prompt = [
    "Use the Task tool exactly once to delegate all file work to a general-purpose subagent.",
    `Tell that subagent to use Read on ${TARGET_FILE}, then use Edit to append exactly this new final line: // ${CLAUDE_SENTINEL}`,
    "The parent must not read or edit the file itself. Wait for the subagent, then stop.",
  ].join(" ");
  const { stdout, stderr } = await execFileWithClosedStdin(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      "Task,Read,Edit",
      "--name",
      `ORG2 provenance E2E ${RUN_ID}`,
    ],
    {
      cwd: repoPath,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: LIVE_CLI_TIMEOUT_MS,
    }
  );
  const result = JSON.parse(stdout.trim());
  if (!result.session_id) {
    throw new Error(
      `Claude Code did not return a session id; stderr=${stderr.slice(-1000)}`
    );
  }
  return { sessionId: result.session_id, prompt };
}

async function runCodexProvenance(repoPath) {
  const prompt = [
    "Use spawn_agent exactly once to delegate all file work to one subagent.",
    `Tell that subagent to use exec_command to run exactly: sed -n '1,40p' ${TARGET_FILE}`,
    `Then tell it to use apply_patch to append exactly this new final line: // ${CODEX_SENTINEL}`,
    "The parent must not read or edit the file itself. Wait for that subagent to finish, then stop.",
  ].join(" ");
  const { stdout, stderr } = await execFileWithClosedStdin(
    "codex",
    [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--dangerously-bypass-hook-trust",
      "-C",
      repoPath,
      prompt,
    ],
    {
      cwd: repoPath,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: LIVE_CLI_TIMEOUT_MS,
    }
  );
  const events = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "thread.started");
  if (!started?.thread_id) {
    throw new Error(
      `Codex did not return a thread id; stderr=${stderr.slice(-1000)}`
    );
  }
  return { sessionId: started.thread_id, prompt };
}

async function runCodexReadOnlyProvenance(repoPath) {
  const prompt = [
    "Use exec_command exactly once.",
    `Run exactly: sed -n '1,10p' ${TARGET_FILE}`,
    "Do not use any other tool and do not modify the file, then stop.",
  ].join(" ");
  const { stdout, stderr } = await execFileWithClosedStdin(
    "codex",
    [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--dangerously-bypass-hook-trust",
      "-C",
      repoPath,
      prompt,
    ],
    {
      cwd: repoPath,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: LIVE_CLI_TIMEOUT_MS,
    }
  );
  const started = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((event) => event.type === "thread.started");
  if (!started?.thread_id) {
    throw new Error(
      `Codex refresh probe did not return a thread id; stderr=${stderr.slice(-1000)}`
    );
  }
  return { sessionId: started.thread_id };
}

async function runCursorProvenance(repoPath) {
  const prompt = [
    `First read ${TARGET_FILE} using the file read tool.`,
    `Then edit it with a file editing tool by appending exactly this new final line: // ${CURSOR_SENTINEL}`,
    "Do not change any existing line. Use no other tools, then stop.",
  ].join(" ");
  const { stdout, stderr } = await execFileWithClosedStdin(
    process.env.CURSOR_AGENT_BIN ?? "agent",
    [
      "-p",
      "--output-format",
      "json",
      "--trust",
      "--force",
      "--workspace",
      repoPath,
      prompt,
    ],
    {
      cwd: repoPath,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: LIVE_CLI_TIMEOUT_MS,
    }
  );
  const result = JSON.parse(stdout.trim());
  if (!result.session_id) {
    throw new Error(
      `Cursor Agent did not return a session id; stderr=${stderr.slice(-1000)}`
    );
  }
  return { sessionId: result.session_id, prompt };
}

async function switchToMyStationCodeEditor() {
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigate to My Station Code Editor"
  );
  // tauri-wd currently cannot serialize this React-owned element for
  // waitForDisplayed/click (Node.contains receives a cross-realm wrapper).
  // This mode switch is deterministic setup; critical timeline interactions
  // below remain real WebDriver clicks.
  const stationSwitch = await execJS(`
    const button = document.querySelector('[data-testid="station-mode-my-station"]');
    if (!button) return 'missing';
    button.click();
    return 'clicked';
  `);
  expect(stationSwitch).toBe("clicked");
  await browser.waitUntil(
    async () => {
      const surface = unwrap(
        await invokeE2E("inspectWorkstationSurface"),
        "inspect My Station route"
      );
      return (
        surface.pathname === "/orgii/workstation/code" &&
        surface.stationMode === "my-station"
      );
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: "My Station route never became active",
    }
  );
}

async function openFileTimeline(repoPath) {
  const absoluteFilePath = join(repoPath, TARGET_FILE);
  unwrap(
    await invokeE2E("openWorkstationFile", absoluteFilePath),
    "open target file in My Station"
  );

  // The workstation host is tab-driven rather than route-driven. Opening the
  // file above creates/focuses the code tab, which is what mounts CodeEditor.
  let reopenAttempts = 0;
  try {
    await browser.waitUntil(
      async () => {
        const surface = unwrap(
          await invokeE2E("inspectWorkstationSurface"),
          "inspect opened workstation file"
        );
        if (
          surface.activeHost === "code" &&
          surface.activeTabType === "file" &&
          surface.activeTabId === `file:${absoluteFilePath}` &&
          surface.codeEditorPresent
        ) {
          return true;
        }
        reopenAttempts += 1;
        if (reopenAttempts % 4 === 0) {
          unwrap(
            await invokeE2E("openWorkstationFile", absoluteFilePath),
            "refocus target file after workstation hydration"
          );
        }
        return false;
      },
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg:
          "My Station Code Editor never rendered after opening the file tab",
      }
    );
  } catch {
    const surface = unwrap(
      await invokeE2E("inspectWorkstationSurface"),
      "inspect missing My Station Code Editor"
    );
    const diagnostic = await execJS(`
      return {
        layout: localStorage.getItem('workstation:layout-v2'),
        bodyTail: (document.body.innerText || '').slice(-1200),
      };
    `);
    throw new Error(
      `My Station Code Editor never rendered; surface=${JSON.stringify(surface)} diagnostic=${JSON.stringify(diagnostic)}`
    );
  }

  const toggleSelector =
    '[data-testid="code-editor-agent-timeline-section-toggle"]';
  await browser.waitUntil(
    async () =>
      execJS(`
        return [...document.querySelectorAll(${JSON.stringify(
          toggleSelector
        )})].some((toggle) => {
          const rect = toggle.getBoundingClientRect();
          const style = window.getComputedStyle(toggle);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
      `),
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: async () =>
        `Timeline section did not mount after opening the target file; state=${JSON.stringify(
          unwrap(
            await invokeE2E("inspectChatState"),
            "inspectChatState(missing Timeline)"
          )
        )}`,
    }
  );
  const collapsed = await execJS(`
    for (const candidate of document.querySelectorAll('[data-e2e-active-timeline-toggle]')) {
      candidate.removeAttribute('data-e2e-active-timeline-toggle');
    }
    const toggle = [...document.querySelectorAll(${JSON.stringify(
      toggleSelector
    )})].filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).at(-1);
    toggle?.setAttribute('data-e2e-active-timeline-toggle', 'true');
    return toggle?.getAttribute('data-collapsed') ?? null;
  `);
  if (collapsed === null) {
    throw new Error("Visible Timeline section disappeared before interaction");
  }
  if (collapsed === "true") {
    await pointerClick(toggleSelector, "expand Timeline section", 30_000);
  }
  await browser.waitUntil(
    async () =>
      execJS(`
        return [...document.querySelectorAll(${JSON.stringify(
          toggleSelector
        )})].some((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && candidate.getAttribute('data-collapsed') === 'false';
        });
      `),
    {
      timeout: 10_000,
      interval: 250,
      timeoutMsg: "Timeline pointer click did not expand the section",
    }
  );
  try {
    await browser.waitUntil(
      async () =>
        execJS(`
          return [...document.querySelectorAll('[data-testid="session-blame-section"]')].some((section) => {
            const rect = section.getBoundingClientRect();
            const style = window.getComputedStyle(section);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          });
        `),
      { timeout: 60_000, interval: 500 }
    );
  } catch {
    const timeline = await execJS(`
      const toggle = document.querySelector('[data-e2e-active-timeline-toggle="true"]');
      const section = toggle?.parentElement?.parentElement;
      return {
        togglePresent: Boolean(toggle),
        collapsed: toggle?.getAttribute('data-collapsed') ?? null,
        sectionText: (section?.innerText || section?.textContent || '').slice(0, 1200),
        sectionHtml: (section?.innerHTML || '').slice(0, 1200),
        bodyTail: (document.body.innerText || '').slice(-1200),
      };
    `);
    throw new Error(
      `Session Blame section never rendered; timeline=${JSON.stringify(timeline)}`
    );
  }
}

describe("Session Provenance live (real vendor hooks → Session Blame)", () => {
  let repoPath = null;
  let orgiiHome = null;

  before(async function () {
    await waitForApp();
    repoPath = process.env.E2E_REPO_PATH;
    if (!repoPath) throw new Error("E2E_REPO_PATH missing");
    orgiiHome = process.env.ORGII_HOME;
    if (!orgiiHome) throw new Error("ORGII_HOME missing for isolated E2E run");
  });

  it("renders and opens live Claude Code, Codex, and Cursor session provenance", async function () {
    this.timeout(900_000);
    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath }),
      "ensureRepoSelected(external session provenance)"
    );
    if (!existsSync(join(repoPath, TARGET_FILE))) {
      // Deterministic setup only. Every claimed provenance fact below still
      // comes from a real vendor tool invocation, production hook, store,
      // query, rendered row, and pointer click.
      writeFileSync(
        join(repoPath, TARGET_FILE),
        `export const marker = "${SENTINEL}";\n`,
        "utf8"
      );
    }
    const claudeHooks = join(homedir(), ".claude", "settings.json");
    const codexHooks = join(homedir(), ".codex", "hooks.json");
    const cursorHooks = join(homedir(), ".cursor", "hooks.json");
    await browser.waitUntil(
      async () =>
        hookConfigContainsMarker(claudeHooks) &&
        hookConfigContainsEvents(codexHooks, [
          "PostToolUse",
          "SubagentStart",
          "SubagentStop",
        ]) &&
        hookConfigContainsEvents(cursorHooks, [
          "postToolUse",
          "subagentStart",
          "subagentStop",
        ]),
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg:
          "ORG2 did not install the Claude Code, Codex, and Cursor hooks",
      }
    );

    const claude = await runClaudeCodeProvenance(repoPath);
    await browser.waitUntil(
      async () =>
        readFileSync(join(repoPath, TARGET_FILE), "utf8").includes(
          CLAUDE_SENTINEL
        ),
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: "Claude Code did not append its provenance sentinel",
      }
    );

    const codex = await runCodexProvenance(repoPath);
    await browser.waitUntil(
      async () =>
        readFileSync(join(repoPath, TARGET_FILE), "utf8").includes(
          CODEX_SENTINEL
        ),
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: "Codex did not append its provenance sentinel",
      }
    );
    let codexActors = [];
    await browser.waitUntil(
      async () => {
        codexActors = await codexActorRows(orgiiHome, codex.sessionId);
        return codexActors.some(
          (actor) =>
            actor.actorId &&
            actor.turnId &&
            actor.startedAt &&
            actor.stoppedAt &&
            actor.transcriptSessionId &&
            actor.transcriptSessionId !== actor.sessionId &&
            actor.transcriptPath &&
            existsSync(actor.transcriptPath)
        );
      },
      {
        timeout: 90_000,
        interval: 1_000,
        timeoutMsg: async () =>
          `Codex actor lifecycle/transcript mapping never converged; actors=${JSON.stringify(await codexActorRows(orgiiHome, codex.sessionId))}`,
      }
    );
    const codexMappedActor = codexActors.find(
      (actor) =>
        actor.transcriptSessionId &&
        actor.transcriptSessionId !== actor.sessionId &&
        actor.transcriptPath &&
        existsSync(actor.transcriptPath)
    );
    expect(codexMappedActor).toBeTruthy();
    expect(readFileSync(codexMappedActor.transcriptPath, "utf8")).toContain(
      CODEX_SENTINEL
    );

    const cursor = await runCursorProvenance(repoPath);
    await browser.waitUntil(
      async () =>
        readFileSync(join(repoPath, TARGET_FILE), "utf8").includes(
          CURSOR_SENTINEL
        ),
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: "Cursor Agent did not append its provenance sentinel",
      }
    );

    let rows = [];
    await browser.waitUntil(
      async () => {
        rows = await provenanceRowsForFile(orgiiHome, TARGET_FILE);
        const actionsBySource = new Map();
        for (const row of rows) {
          const actions = actionsBySource.get(row.source) ?? new Set();
          actions.add(row.action);
          actionsBySource.set(row.source, actions);
        }
        const expectedSources = ["claude_code", "codex_app", "cursor_ide"];
        return expectedSources.every(
          (source) =>
            actionsBySource.get(source)?.has("read") &&
            actionsBySource.get(source)?.has("write")
        );
      },
      {
        timeout: 90_000,
        interval: 2_000,
        timeoutMsg: async () =>
          `live read/write provenance never converged; rows=${JSON.stringify(
            await provenanceRowsForFile(orgiiHome, TARGET_FILE)
          )}`,
      }
    );

    expect(
      rows.some(
        (row) =>
          row.source === "claude_code" &&
          row.sessionId.endsWith(claude.sessionId) &&
          row.actorId &&
          row.captureMethod === "hook" &&
          row.attributionPrecision === "exact"
      )
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.source === "codex_app" &&
          codexActors.some(
            (actor) =>
              actor.actorId === row.actorId &&
              actor.transcriptSessionId === row.sessionId
          ) &&
          row.turnId &&
          row.captureMethod === "hook" &&
          row.attributionPrecision === "exact"
      )
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.source === "cursor_ide" &&
          row.sessionId.endsWith(cursor.sessionId) &&
          row.turnId === cursor.sessionId &&
          row.captureMethod === "hook" &&
          row.attributionPrecision === "session_only"
      )
    ).toBe(true);

    const serializedPayloads = rows.map((row) => row.payload).join("\n");
    for (const privateValue of [
      SENTINEL,
      CLAUDE_SENTINEL,
      CODEX_SENTINEL,
      CURSOR_SENTINEL,
    ]) {
      expect(serializedPayloads).not.toContain(privateValue);
    }

    const firstHistoryReadStartedAt = Date.now();
    const firstWireHistory = unwrap(
      await invokeE2E("inspectOrgtrackFileSessionHistory", {
        repoPath,
        filePath: TARGET_FILE,
      }),
      "inspect production file session history"
    ).history;
    expect(Date.now() - firstHistoryReadStartedAt).toBeLessThan(5_000);
    expect([
      "queued",
      "discovering",
      "indexing",
      "complete",
      "partial",
    ]).toContain(firstWireHistory.backfill.status);
    expect(firstWireHistory.revision).toBeGreaterThan(0);
    expect(firstWireHistory.page.offset).toBe(0);
    expect(firstWireHistory.page.limit).toBe(30);

    const expectedSources = ["claude_code", "codex_app", "cursor_ide"];
    let wireHistory = firstWireHistory;
    await browser.waitUntil(
      async () => {
        wireHistory = unwrap(
          await invokeE2E("inspectOrgtrackFileSessionHistory", {
            repoPath,
            filePath: TARGET_FILE,
          }),
          "poll production file session history"
        ).history;
        const terminal = ["complete", "partial"].includes(
          wireHistory.backfill.status
        );
        return (
          terminal &&
          expectedSources.every((source) =>
            wireHistory.sessions.some((session) => session.source === source)
          )
        );
      },
      {
        timeout: 120_000,
        interval: 1_000,
        timeoutMsg:
          "historical Session Blame backfill did not reach terminal coverage",
      }
    );
    for (const source of expectedSources) {
      expect(
        wireHistory.sessions.some((session) => session.source === source)
      ).toBe(true);
    }
    expect(wireHistory.page.totalSessions).toBeGreaterThanOrEqual(3);
    const claudeWireChild = wireHistory.sessions
      .filter((session) => session.source === "claude_code")
      .flatMap((session) =>
        session.participants.map((participant) => ({ session, participant }))
      )
      .find(
        ({ session, participant }) =>
          participant.participantKind === "subagent" &&
          participant.parentSessionId === session.sessionId &&
          participant.sessionId !== session.sessionId
      );
    expect(claudeWireChild).toBeTruthy();
    expect(claudeWireChild.session.sessionId).toMatch(
      new RegExp(`${claude.sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
    );
    const codexWireChild = wireHistory.sessions
      .filter(
        (session) =>
          session.source === "codex_app" &&
          session.sessionId.endsWith(codex.sessionId)
      )
      .flatMap((session) =>
        session.participants.map((participant) => ({ session, participant }))
      )
      .find(
        ({ session, participant }) =>
          participant.participantKind === "subagent" &&
          participant.parentSessionId === session.sessionId &&
          participant.actorId &&
          participant.transcriptSessionId &&
          participant.transcriptSessionId !== session.transcriptSessionId
      );
    expect(codexWireChild).toBeTruthy();
    expect(codexWireChild.session.transcriptSessionId).toBe(
      codexWireChild.session.sessionId
    );

    await switchToMyStationCodeEditor();
    await openFileTimeline(repoPath);

    const rendered = await execJS(`
      return [...document.querySelectorAll('[data-testid="session-blame-session-header"], [data-testid="session-blame-entry"]')]
        .filter((row) => {
          const rect = row.getBoundingClientRect();
          const style = window.getComputedStyle(row);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map((row) => ({
        source: row.getAttribute('data-session-source'),
        sessionId: row.getAttribute('data-session-id'),
        transcriptSessionId: row.getAttribute('data-transcript-session-id'),
        originSessionId: row.getAttribute('data-origin-session-id'),
        participantKind: row.getAttribute('data-participant-kind'),
        actorId: row.getAttribute('data-actor-id'),
        precision: row.getAttribute('data-attribution-precision'),
        readCount: Number(row.getAttribute('data-read-count') || '0'),
        writeCount: Number(row.getAttribute('data-write-count') || '0'),
        rootTranscriptSessionId: row.closest('[data-testid="session-blame-session"]')
          ?.querySelector('[data-testid="session-blame-session-header"]')
          ?.getAttribute('data-transcript-session-id') ?? null,
        text: row.innerText || row.textContent || '',
        }));
    `);
    const renderedPage = await execJS(`
      const section = [...document.querySelectorAll('[data-testid="session-blame-section"]')]
        .find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      return {
        revision: Number(section?.getAttribute('data-history-revision') || '0'),
        loaded: Number(section?.getAttribute('data-loaded-sessions') || '0'),
        total: Number(section?.getAttribute('data-total-sessions') || '0'),
      };
    `);
    expect(renderedPage.revision).toBeGreaterThan(0);
    expect(renderedPage.loaded).toBeGreaterThanOrEqual(3);
    expect(renderedPage.total).toBeGreaterThanOrEqual(renderedPage.loaded);
    for (const source of expectedSources) {
      const entry = rendered.find((row) => row.source === source);
      expect(entry).toBeTruthy();
      expect(entry.readCount).toBeGreaterThan(0);
      expect(entry.writeCount).toBeGreaterThan(0);
    }
    expect(
      rendered.some(
        (row) =>
          row.participantKind !== "root" &&
          row.transcriptSessionId &&
          row.transcriptSessionId === row.rootTranscriptSessionId
      )
    ).toBe(false);

    // Keep the panel open, then create a new real Codex hook fact. The
    // SQLite revision + lightweight invalidation event must update rendered
    // Session Blame without reopening the file or retaining a history cache.
    const revisionBeforeLiveRefresh = wireHistory.revision;
    const refreshCodex = await runCodexReadOnlyProvenance(repoPath);
    await browser.waitUntil(
      async () => {
        const refreshedHistory = unwrap(
          await invokeE2E("inspectOrgtrackFileSessionHistory", {
            repoPath,
            filePath: TARGET_FILE,
          }),
          "inspect live-refreshed file session history"
        ).history;
        const renderedRefreshRow = await execJS(`
          return [...document.querySelectorAll('[data-testid="session-blame-session-header"]')]
            .some((row) =>
              row.getAttribute('data-session-source') === 'codex_app' &&
              (row.getAttribute('data-session-id') || '').endsWith(${JSON.stringify(refreshCodex.sessionId)}) &&
              Number(row.getAttribute('data-read-count') || '0') > 0
            );
        `);
        return (
          refreshedHistory.revision > revisionBeforeLiveRefresh &&
          renderedRefreshRow
        );
      },
      {
        timeout: 90_000,
        interval: 1_000,
        timeoutMsg:
          "open Session Blame panel did not refresh after a new real Codex hook fact",
      }
    );

    const claudeSubagent = rendered.find(
      (row) => row.source === "claude_code" && row.actorId
    );
    expect(claudeSubagent).toBeTruthy();
    expect(claudeSubagent.participantKind).toBe("subagent");
    expect(claudeSubagent.precision).toBe("exact");
    expect(claudeSubagent.sessionId).not.toBe(claudeSubagent.originSessionId);
    // The visible role/precision labels are localized. Assert the stable
    // semantic attributes above and participant-specific content here so the
    // scenario remains valid in every supported UI language.
    expect(claudeSubagent.text).toContain(TARGET_FILE);

    const codexSubagent = rendered.find(
      (row) => row.source === "codex_app" && row.actorId
    );
    expect(codexSubagent).toBeTruthy();
    expect(codexSubagent.participantKind).toBe("subagent");
    expect(codexSubagent.transcriptSessionId).toBeTruthy();
    expect(codexSubagent.transcriptSessionId).not.toBe(
      codexSubagent.originSessionId
    );

    const claudeRootSessionId = claudeWireChild.session.sessionId;
    const claudeChildSessionId = claudeWireChild.participant.sessionId;
    await pointerClick(
      `[data-testid="session-blame-session"][data-session-id="${claudeRootSessionId}"] [data-testid="session-blame-session-header"]`,
      "Claude root Session Blame entry"
    );
    let rootTranscript = null;
    await browser.waitUntil(
      async () => {
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          "inspectChatState(after root Session Blame click)"
        );
        rootTranscript = await visibleChatTranscriptSnapshot();
        return (
          state.activeSessionId === claudeRootSessionId &&
          rootTranscript.sessionId === claudeRootSessionId &&
          rootTranscript.historyCount > 0 &&
          rootTranscript.text.length > 0
        );
      },
      {
        timeout: 90_000,
        interval: 1_000,
        timeoutMsg: async () =>
          `root Session Blame entry did not render its own transcript; snapshot=${JSON.stringify(await visibleChatTranscriptSnapshot())}`,
      }
    );

    // Reopen the same file while the root session tab is active. Clicking the
    // child must repoint that tab; merely changing activeSessionId is not a
    // sufficient navigation proof because ChatView renders from tab.sessionId.
    await switchToMyStationCodeEditor();
    await openFileTimeline(repoPath);
    await pointerClick(
      `[data-testid="session-blame-entry"][data-session-id="${claudeChildSessionId}"]`,
      "Claude subagent Session Blame entry"
    );
    let childTranscript = null;
    await browser.waitUntil(
      async () => {
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          "inspectChatState(after Session Blame click)"
        );
        childTranscript = await visibleChatTranscriptSnapshot();
        return (
          state.activeSessionId === claudeChildSessionId &&
          childTranscript.sessionId === claudeChildSessionId &&
          childTranscript.historyCount > 0 &&
          childTranscript.text.length > 0
        );
      },
      {
        timeout: 90_000,
        interval: 1_000,
        timeoutMsg: async () =>
          `subagent Session Blame entry did not render its own transcript; snapshot=${JSON.stringify(await visibleChatTranscriptSnapshot())}`,
      }
    );
    expect(childTranscript.text).toContain(TARGET_FILE);
    expect(childTranscript.text).not.toBe(rootTranscript.text);

    const codexRootSessionId = codexWireChild.session.transcriptSessionId;
    const codexChildSessionId = codexWireChild.participant.transcriptSessionId;
    await switchToMyStationCodeEditor();
    await openFileTimeline(repoPath);
    await pointerClick(
      `[data-testid="session-blame-session"] [data-testid="session-blame-session-header"][data-transcript-session-id="${codexRootSessionId}"]`,
      "Codex root Session Blame entry"
    );
    let codexRootTranscript = null;
    await browser.waitUntil(
      async () => {
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          "inspectChatState(after Codex root click)"
        );
        codexRootTranscript = await visibleChatTranscriptSnapshot();
        return (
          state.activeSessionId === codexRootSessionId &&
          codexRootTranscript.sessionId === codexRootSessionId &&
          codexRootTranscript.historyCount > 0 &&
          codexRootTranscript.text.length > 0
        );
      },
      {
        timeout: 90_000,
        interval: 1_000,
        timeoutMsg: async () =>
          `Codex root transcript did not render; snapshot=${JSON.stringify(await visibleChatTranscriptSnapshot())}`,
      }
    );

    let codexRootSidebar = null;
    await browser.waitUntil(
      async () => {
        codexRootSidebar =
          await visibleSidebarSessionSnapshot(codexRootSessionId);
        return (
          codexRootSidebar.present &&
          codexRootSidebar.selected &&
          codexRootSidebar.sectionExpanded &&
          codexRootSidebar.withinScrollViewport &&
          !codexRootSidebar.sidebarCollapsed
        );
      },
      {
        timeout: 60_000,
        interval: 500,
        timeoutMsg: async () =>
          `Codex root did not synchronize to its visible sidebar group; snapshot=${JSON.stringify(await visibleSidebarSessionSnapshot(codexRootSessionId))}`,
      }
    );

    await switchToMyStationCodeEditor();
    await openFileTimeline(repoPath);
    expect(codexRootSidebar.sectionId).toBeTruthy();
    await collapseSidebarSection(codexRootSidebar.sectionId);
    await pointerClick(
      `[data-testid="session-blame-entry"][data-transcript-session-id="${codexChildSessionId}"]`,
      "Codex subagent Session Blame entry"
    );
    let codexChildTranscript = null;
    await browser.waitUntil(
      async () => {
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          "inspectChatState(after Codex child click)"
        );
        codexChildTranscript = await visibleChatTranscriptSnapshot();
        return (
          state.activeSessionId === codexChildSessionId &&
          codexChildTranscript.sessionId === codexChildSessionId &&
          codexChildTranscript.historyCount > 0 &&
          codexChildTranscript.text.length > 0
        );
      },
      {
        timeout: 90_000,
        interval: 1_000,
        timeoutMsg: async () =>
          `Codex child transcript did not render; snapshot=${JSON.stringify(await visibleChatTranscriptSnapshot())}`,
      }
    );
    expect(codexChildTranscript.text).not.toBe(codexRootTranscript.text);

    let codexChildSidebar = null;
    try {
      await browser.waitUntil(
        async () => {
          codexChildSidebar =
            await visibleSidebarSessionSnapshot(codexChildSessionId);
          return (
            codexChildSidebar.present &&
            codexChildSidebar.selected &&
            codexChildSidebar.sectionId === codexRootSidebar.sectionId &&
            codexChildSidebar.sectionExpanded &&
            codexChildSidebar.withinScrollViewport &&
            !codexChildSidebar.sidebarCollapsed
          );
        },
        {
          timeout: 60_000,
          interval: 500,
          timeoutMsg:
            "Codex subagent did not expand/select/scroll its sidebar row",
        }
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(codexChildSidebar)}`
      );
    }
  });
});
