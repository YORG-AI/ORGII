/* global describe, before, after, it, browser */
/**
 * Rendered proof for compact first-run preference setup.
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

describe("Quick setup preferences (rendered UI)", () => {
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
    await visible('[data-testid="setup-preferences"]');
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
        "general.language": originalSettings["general.language"],
        "general.theme": originalSettings["general.theme"],
        "general.primaryColor": originalSettings["general.primaryColor"],
      }),
      "restore setup settings"
    );
  });

  it("persists a visible preference change and completes in one action", async () => {
    const legacyStepCount = await browser.executeScript(
      "return document.querySelectorAll('[data-testid^=setup-step-]').length;",
      []
    );
    if (legacyStepCount !== 0) {
      throw new Error(`quick setup still renders ${legacyStepCount} step rows`);
    }

    await click('[data-testid="setup-primary-color"]');
    const violetOption = await browser.$(
      '//*[normalize-space(text())="Violet"]'
    );
    await violetOption.waitForDisplayed({ timeout: WAIT_MS });
    await violetOption.click();
    await browser.waitUntil(
      async () => {
        const settings = unwrap(
          await invokeE2E("readSettings"),
          "read changed quick-setup preference"
        ).settings;
        return settings["general.primaryColor"] === "violet";
      },
      {
        timeout: WAIT_MS,
        interval: 200,
        timeoutMsg: "primary color selection was not persisted",
      }
    );

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
    const completedSettings = unwrap(
      await invokeE2E("readSettings"),
      "read completed quick-setup settings"
    ).settings;
    const completedProgress =
      completedSettings["general.setupWalkthroughProgress"];
    if (
      completedSettings["general.setupWalkthroughOutcome"] !== "completed" ||
      completedProgress?.currentStepId !== "preferences" ||
      !completedProgress?.completedStepIds?.includes("preferences")
    ) {
      throw new Error(
        `quick setup did not commit completion atomically: ${JSON.stringify({
          outcome: completedSettings["general.setupWalkthroughOutcome"],
          progress: completedProgress,
        })}`
      );
    }
  });

  it("reopens quick setup through the hidden release-build shortcut", async () => {
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

    await visible('[data-testid="setup-preferences"]');
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
