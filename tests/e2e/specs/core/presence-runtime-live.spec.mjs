/* global describe, before, after, it, browser */
/**
 * Presence runtime — live LLM coverage for the two backend-authoritative
 * auto-resolve chains plus the goal-budget pause path. Companion to
 * goal-loop-live.spec.mjs (which covers the happy continuation path).
 *
 * 1. Question auto-skip: real agent calls ask_user_questions → the
 *    presence deadline watcher fires → backend skips with the "use your
 *    best judgment" tool result → agent continues and produces the
 *    artifact, with ZERO clicks from the test.
 * 2. Plan auto-approve: real agent writes a plan in Plan mode → the
 *    auto-approve watcher fires at created_at+N → same path as clicking
 *    Build → build turn runs and produces the artifact, zero clicks.
 * 3. Goal budget exhaustion: invisible goal loop with budget 1 against a
 *    structurally multi-turn goal → "Goal paused" surfaces in the UI.
 *
 * Stance vs numbers decoupling (deliberate): tests 1–2 run in ONLINE
 * mode with settings-overridden timers. Stance only shapes the prompt
 * (how eagerly the LLM asks); the watchers key off the policy NUMBERS,
 * which any mode may set. Using Online keeps the LLM willing to ask /
 * plan while still proving the watchers fire.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  configureScenario,
  execJS,
  filteredConfigs,
  invokeE2E,
  js,
  listAccounts,
  rustAgentConfigs,
  scenarioConfigs,
  stopActiveTurnIfNeeded,
  typeAndClickSend,
  unwrap,
  waitForApp,
  waitForChatLaunched,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const RUN_ID = Date.now();
const CHAT_INPUT = '[data-testid="chat-input"] [contenteditable="true"]';
const LIVE_TIMEOUT_MS = 300_000;

const QUESTION_SKIP_SECS = 10;
const PLAN_APPROVE_SECS = 20;
const PAUSE_GOAL_BUDGET = 1;

async function readSettings() {
  return unwrap(await invokeE2E("readSettings"), "read settings").settings;
}

async function writeSettingsPartial(partial) {
  unwrap(
    await invokeE2E("writeSettingsPartial", partial),
    "write settings partial"
  );
}

async function setPresenceMode(mode, expectedPolicy = {}) {
  const roles = await browser.executeScript(
    `return JSON.parse(localStorage.getItem("orgii:userCustomRoles") || "[]");`,
    []
  );
  let snapshot = null;
  await browser.waitUntil(
    async () => {
      snapshot = unwrap(
        await invokeE2E("seedUserPresence", {
          roles,
          presence: { mode },
        }),
        `set presence ${mode}`
      ).wire;
      return (
        snapshot?.mode === mode &&
        Object.entries(expectedPolicy).every(
          ([key, value]) => snapshot?.[key] === value
        )
      );
    },
    {
      timeout: 10_000,
      interval: 250,
      timeoutMsg: () =>
        `presence wire did not resolve requested policy; mode=${mode} expected=${JSON.stringify(expectedPolicy)} actual=${JSON.stringify(snapshot)}`,
    }
  );
  // Let useUserPresenceSync deliver the resolved wire to the Rust runtime.
  await browser.pause(500);
}

describe("Presence runtime live (auto-skip / auto-approve / budget pause)", () => {
  let config = null;
  let repoPath = null;
  const originals = {};

  before(async function () {
    await waitForApp();
    const accounts = await listAccounts();
    let rustConfigs = [];
    try {
      rustConfigs = rustAgentConfigs(
        filteredConfigs(scenarioConfigs(accounts))
      );
    } catch (error) {
      console.warn(
        `[presence-runtime-provider-blocker] ${error instanceof Error ? error.message : String(error)}`
      );
      this.skip();
      return;
    }
    if (rustConfigs.length === 0) {
      console.warn(
        "[presence-runtime-provider-blocker] no configured account supports a Rust-agent runtime scenario"
      );
      this.skip();
      return;
    }
    config =
      rustConfigs.find((row) => row.label === "claude-code-rust-agent") ??
      rustConfigs[0];
    repoPath = process.env.E2E_REPO_PATH;
    if (!repoPath) throw new Error("E2E_REPO_PATH missing");

    const settings = await readSettings();
    originals.question =
      settings["agent.sde.questionAutoSkipTimeoutByPresence"];
    originals.plan = settings["agent.sde.planAutoApproveTimeoutByPresence"];
    originals.goal = settings["agent.sde.goalMaxTurnsByPresence"];
  });

  after(async () => {
    await setPresenceMode("online");
    const restore = {};
    if (originals.question)
      restore["agent.sde.questionAutoSkipTimeoutByPresence"] =
        originals.question;
    if (originals.plan)
      restore["agent.sde.planAutoApproveTimeoutByPresence"] = originals.plan;
    if (originals.goal)
      restore["agent.sde.goalMaxTurnsByPresence"] = originals.goal;
    if (Object.keys(restore).length > 0) await writeSettingsPartial(restore);
    await stopActiveTurnIfNeeded("presence-live-cleanup");
  });

  it("auto-skips a pending question and the agent finishes with best judgment", async () => {
    await writeSettingsPartial({
      "agent.sde.questionAutoSkipTimeoutByPresence": {
        ...(originals.question ?? {}),
        online: QUESTION_SKIP_SECS,
      },
    });
    await configureScenario(config, { agentExecMode: "build" });
    await setPresenceMode("online", {
      questionAutoResolveSecs: QUESTION_SKIP_SECS,
    });

    const fileA = `presence-q-alpha-${RUN_ID}.txt`;
    const fileB = `presence-q-beta-${RUN_ID}.txt`;
    const prompt = [
      `First, ask me ONE question with your ask_user_questions tool:`,
      `"Which filename should I use?" with the two options ${fileA} and ${fileB}.`,
      `Wait for my answer. If the question gets skipped instead of answered,`,
      `pick whichever option you prefer yourself, create that one file in the`,
      `repo root with content "chosen", and finish.`,
    ].join(" ");

    await typeAndClickSend(CHAT_INPUT, prompt);
    await waitForChatLaunched(prompt);

    // 1. The rendered question card must appear (the agent really asked).
    let bodySnapshot = "";
    await browser.waitUntil(
      async () => {
        bodySnapshot = await execJS(js.bodyText);
        return bodySnapshot.includes("Which filename should I use");
      },
      {
        timeout: LIVE_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: () =>
          `question card never rendered; tail=${JSON.stringify(bodySnapshot.slice(-1200))}`,
      }
    );

    // 2. ZERO clicks: the deadline watcher must skip the question and the
    //    agent must continue to the artifact on its own.
    await browser.waitUntil(
      async () =>
        existsSync(join(repoPath, fileA)) || existsSync(join(repoPath, fileB)),
      {
        timeout: LIVE_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: async () =>
          `auto-skip never let the agent finish; tail=${JSON.stringify((await execJS(js.bodyText)).slice(-1500))}`,
      }
    );
  });

  it("auto-approves a pending plan and the build turn produces the artifact", async () => {
    await writeSettingsPartial({
      "agent.sde.planAutoApproveTimeoutByPresence": {
        ...(originals.plan ?? {}),
        online: PLAN_APPROVE_SECS,
      },
    });
    await configureScenario(config, { agentExecMode: "plan" });
    await setPresenceMode("online", {
      planAutoApproveSecs: PLAN_APPROVE_SECS,
    });

    const marker = `presence-plan-done-${RUN_ID}.txt`;
    const prompt = [
      `Create a file named ${marker} in the repo root with content DONE.`,
      `Since you are in plan mode, write the plan first; after the plan is`,
      `approved, implement it exactly.`,
    ].join(" ");

    await typeAndClickSend(CHAT_INPUT, prompt);
    await waitForChatLaunched(prompt);

    // 1. A pending, buildable plan must render. This deliberately uses the
    //    plan surface contract instead of localized button/body copy.
    let planSnapshot = null;
    await browser.waitUntil(
      async () => {
        planSnapshot = await execJS(js.planUi);
        return (
          (planSnapshot.visibleReadyCardCount > 0 &&
            planSnapshot.visibleEnabledBuildButtonCount > 0) ||
          (planSnapshot.planDocPanelVisible &&
            planSnapshot.planDocBuildVisible &&
            planSnapshot.planDocBuildEnabled)
        );
      },
      {
        timeout: LIVE_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: () =>
          `buildable plan approval surface never rendered; ui=${JSON.stringify(planSnapshot)}`,
      }
    );

    // 2. ZERO clicks: the auto-approve watcher must fire and the build
    //    turn must create the marker file.
    await browser.waitUntil(async () => existsSync(join(repoPath, marker)), {
      timeout: LIVE_TIMEOUT_MS,
      interval: 3_000,
      timeoutMsg: async () =>
        `auto-approve never produced the artifact; tail=${JSON.stringify((await execJS(js.bodyText)).slice(-1500))}`,
    });
  });

  it("pauses the goal loop when the turn budget is exhausted", async () => {
    await writeSettingsPartial({
      "agent.sde.goalMaxTurnsByPresence": {
        ...(originals.goal ?? {}),
        invisible: PAUSE_GOAL_BUDGET,
      },
    });
    await configureScenario(config, { agentExecMode: "build" });
    await setPresenceMode("invisible", {
      goalMaxTurns: PAUSE_GOAL_BUDGET,
    });

    const stem = `presence-pause-${RUN_ID}`;
    const files = [1, 2, 3, 4].map((n) => `${stem}-${n}.txt`);
    const prompt = [
      `Create four files in the repo root: ${files.join(", ")}.`,
      `Each file's content must be its own filename.`,
      `STRICT RULE: you may create exactly ONE of these files per reply.`,
      `After creating one file, end your reply immediately — do not create`,
      `the next file in the same reply, do not ask questions.`,
    ].join(" ");

    await typeAndClickSend(CHAT_INPUT, prompt);
    await waitForChatLaunched(prompt);

    // Budget 1 → exactly one continuation runs, then the next turn-end
    // hits the backstop and broadcasts paused. The toast must surface.
    let bodySnapshot = "";
    await browser.waitUntil(
      async () => {
        bodySnapshot = await execJS(js.bodyText);
        return bodySnapshot.includes("Goal paused");
      },
      {
        timeout: LIVE_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: () =>
          `goal paused toast never rendered; tail=${JSON.stringify(bodySnapshot.slice(-1500))}`,
      }
    );

    // Negative: with budget 1 the 4-file goal cannot have completed.
    const allDone = files.every((name) => existsSync(join(repoPath, name)));
    if (allDone) {
      throw new Error(
        "all four goal files exist — budget backstop did not stop the loop"
      );
    }
  });
});
