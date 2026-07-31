/* global describe, before, after, it, browser */
/**
 * Rendered proof for the goal-driven setup flow.
 *
 * Fixture helpers only preserve/restore persisted settings and navigate. Every
 * transition below uses the production buttons and the real settings writer;
 * no debug helper marks a step complete or manufactures readiness.
 */
import {
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

const SETUP_ROUTE = "/orgii/app/walkthrough";
const WAIT_MS = 30_000;
let originalSettings = null;

async function visible(selector) {
  await browser.waitUntil(
    async () =>
      browser.executeScript(
        `
          const element = document.querySelector(arguments[0]);
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 &&
            style.visibility !== "hidden" && style.display !== "none";
        `,
        [selector]
      ),
    { timeout: WAIT_MS, interval: 200, timeoutMsg: `${selector} not visible` }
  );
}

async function click(selector) {
  await visible(selector);
  const element = await browser.$(selector);
  await element.scrollIntoView({ block: "center", inline: "center" });
  await element.moveTo();
  await element.click();
}

describe("Goal-driven setup walkthrough (rendered UI)", () => {
  before(async function () {
    await waitForApp();
    originalSettings = unwrap(
      await invokeE2E("readSettings"),
      "read setup settings"
    ).settings;
    unwrap(
      await invokeE2E("navigateTo", SETUP_ROUTE),
      "navigate to setup checklist"
    );
    await visible('[data-testid="setup-step-goal"]');
    if (process.env.E2E_SETUP_GOAL_SCREENSHOT) {
      await browser.saveScreenshot(process.env.E2E_SETUP_GOAL_SCREENSHOT);
    }
  });

  after(async function () {
    if (!originalSettings) return;
    unwrap(
      await invokeE2E("writeSettingsPartial", {
        "general.setupWalkthroughOutcome":
          originalSettings["general.setupWalkthroughOutcome"],
        "general.setupWalkthroughProgress":
          originalSettings["general.setupWalkthroughProgress"],
      }),
      "restore setup settings"
    );
  });

  it("completes the personal path and opens the real Launchpad", async () => {
    // Returning users can reopen the checklist and revisit completed steps.
    await click('[data-testid="setup-step-goal"]');
    await click('[data-testid="setup-goal-personal"]');
    await click('[data-testid="setup-continue"]');

    await visible('[data-testid="setup-step-tools"][aria-current="step"]');
    // Tool detection is optional for this path; Continue remains an explicit
    // user decision rather than a test-only state seed.
    await click('[data-testid="setup-continue"]');

    await visible('[data-testid="setup-step-basics"][aria-current="step"]');
    await click('[data-testid="setup-continue"]');

    await visible('[data-testid="setup-step-tutorial"][aria-current="step"]');
    await click('[data-testid="setup-continue"]');

    await visible('[data-testid="setup-step-work-model"][aria-current="step"]');
    await click('[data-testid="setup-continue"]');

    await visible('[data-testid="setup-step-ready"][aria-current="step"]');
    if (process.env.E2E_SETUP_SCREENSHOT) {
      await browser.saveScreenshot(process.env.E2E_SETUP_SCREENSHOT);
    }
    await click('[data-testid="setup-finish"]');

    await browser.waitUntil(
      async () =>
        browser.executeScript(
          "return window.location.pathname.startsWith('/orgii/workstation');",
          []
        ),
      {
        timeout: WAIT_MS,
        interval: 200,
        timeoutMsg: "setup did not land in the Workstation",
      }
    );
    await visible('[data-testid="chat-panel-start-page"]');
  });

  it("reopens a fresh checklist through the hidden release-build shortcut", async () => {
    const isMac = await browser.executeScript(
      "return navigator.platform.toUpperCase().includes('MAC');",
      []
    );
    await browser.executeScript(
      `
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "o",
          code: "KeyO",
          metaKey: arguments[0],
          ctrlKey: !arguments[0],
          altKey: true,
          shiftKey: false,
          bubbles: true,
          cancelable: true,
        }));
      `,
      [isMac]
    );

    await visible('[data-testid="setup-step-goal"][aria-current="step"]');
    const settings = unwrap(
      await invokeE2E("readSettings"),
      "read shortcut-reset setup settings"
    ).settings;
    const progress = settings["general.setupWalkthroughProgress"];

    if (
      settings["general.setupWalkthroughOutcome"] !== "open" ||
      progress?.currentStepId !== "goal" ||
      progress?.goal !== null ||
      progress?.completedStepIds?.length !== 0
    ) {
      throw new Error(
        `hidden shortcut did not reset setup state: ${JSON.stringify({
          outcome: settings["general.setupWalkthroughOutcome"],
          progress,
        })}`
      );
    }
  });
});
