/* global describe, before, after, it, browser */
/**
 * Goal loop — live runtime coverage ("invisible keeps working").
 *
 * The ONLY spec that exercises the full goal-loop chain with a real
 * provider: user message sets the standing goal → turn ends → judge
 * (session's own model) says not-done → continuation enqueued as a
 * Queue-sourced user message → agent keeps working → goal achieved.
 *
 * Determinism strategy: the goal REQUIRES multiple turns by rule
 * ("create exactly ONE file per reply"), so the first reply can never
 * satisfy the judge. Budget is set to 3 so the loop can reach the
 * achieved state instead of pausing at the boundary.
 *
 * Asserts (rendered + filesystem, not just events):
 *   1. at least one "↻ Continuing toward goal" row renders in the
 *      transcript (loop fired, counter visible),
 *   2. all three goal files exist in the fixture repo (loop drove the
 *      work to completion with zero human input).
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

const GOAL_FILES = ["goal-one.txt", "goal-two.txt", "goal-three.txt"];
const GOAL_TURN_BUDGET = 3;
const GOAL_LOOP_TIMEOUT_MS = 360_000;

const CHAT_INPUT = '[data-testid="chat-input"] [contenteditable="true"]';

async function readSettings() {
  return unwrap(await invokeE2E("readSettings"), "read settings").settings;
}

async function writeSettingsPartial(partial) {
  unwrap(
    await invokeE2E("writeSettingsPartial", partial),
    "write settings partial"
  );
}

/** Seed presence via StorageEvent so live atomWithStorage atoms update
 *  without a reload (reload kills the tauri-wd session). The
 *  useUserPresenceSync hook then pushes the resolved wire spec to Rust
 *  via set_user_presence. */
async function setPresenceMode(mode) {
  await browser.executeScript(
    `
      const serialized = JSON.stringify({ mode: arguments[0] });
      localStorage.setItem("orgii:userPresence", serialized);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "orgii:userPresence",
          newValue: serialized,
          storageArea: localStorage,
        })
      );
      return true;
    `,
    [mode]
  );
  // Give the sync hook one tick to invoke set_user_presence.
  await browser.pause(1_000);
}

describe("Goal loop keeps working while Invisible", () => {
  let config = null;
  let repoPath = null;
  let originalGoalByPresence = null;

  before(async function () {
    await waitForApp();
    const accounts = await listAccounts();
    const rustConfigs = rustAgentConfigs(
      filteredConfigs(scenarioConfigs(accounts))
    );
    if (rustConfigs.length === 0) {
      this.skip();
      return;
    }
    config =
      rustConfigs.find((row) => row.label === "claude-code-rust-agent") ??
      rustConfigs[0];
    repoPath = process.env.E2E_REPO_PATH;
    if (!repoPath) throw new Error("E2E_REPO_PATH missing");

    const settings = await readSettings();
    originalGoalByPresence = settings["agent.sde.goalMaxTurnsByPresence"];
    await writeSettingsPartial({
      "agent.sde.goalMaxTurnsByPresence": {
        ...(originalGoalByPresence ?? {}),
        invisible: GOAL_TURN_BUDGET,
      },
    });
  });

  after(async () => {
    await setPresenceMode("online");
    if (originalGoalByPresence) {
      await writeSettingsPartial({
        "agent.sde.goalMaxTurnsByPresence": originalGoalByPresence,
      });
    }
    await stopActiveTurnIfNeeded("goal-loop-cleanup");
  });

  it("continues toward a multi-turn goal with zero human input", async () => {
    await configureScenario(config, { agentExecMode: "build" });
    await setPresenceMode("invisible");

    const prompt = [
      `Create three files in the repo root: ${GOAL_FILES.join(", ")}.`,
      `Each file's content must be its own filename.`,
      `STRICT RULE: you may create exactly ONE of these files per reply.`,
      `After creating one file, end your reply immediately — do not`,
      `create the next file in the same reply, do not ask questions.`,
    ].join(" ");

    await typeAndClickSend(CHAT_INPUT, prompt);
    await waitForChatLaunched(prompt);

    // 1. The loop must fire: a continuation row renders in the chat.
    let bodySnapshot = "";
    await browser.waitUntil(
      async () => {
        bodySnapshot = await execJS(js.bodyText);
        return bodySnapshot.includes("Continuing toward goal");
      },
      {
        timeout: GOAL_LOOP_TIMEOUT_MS,
        interval: 3_000,
        timeoutMsg: () =>
          `no goal continuation row rendered; tail=${JSON.stringify(
            bodySnapshot.slice(-1500)
          )}`,
      }
    );

    // 2. The loop must finish the job: all three files on disk.
    await browser.waitUntil(
      async () => GOAL_FILES.every((name) => existsSync(join(repoPath, name))),
      {
        timeout: GOAL_LOOP_TIMEOUT_MS,
        interval: 3_000,
        timeoutMsg: () => {
          const missing = GOAL_FILES.filter(
            (name) => !existsSync(join(repoPath, name))
          );
          return `goal files never completed; missing=${JSON.stringify(missing)}; tail=${JSON.stringify(bodySnapshot.slice(-1500))}`;
        },
      }
    );
  });
});
