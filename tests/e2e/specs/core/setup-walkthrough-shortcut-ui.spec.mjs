/* global describe, before, it, browser */

const WAIT_MS = 30_000;

async function setupPreferencesVisible() {
  return browser.executeScript(
    `
      const element = document.querySelector('[data-testid="setup-preferences"]');
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.visibility !== "hidden" && style.display !== "none";
    `,
    []
  );
}

describe("Setup walkthrough shortcut entry (rendered UI)", () => {
  before(async () => {
    await browser.setTimeout({ script: WAIT_MS });
    await browser.waitUntil(
      async () =>
        browser.executeScript(
          `
            try {
              window.localStorage.setItem("orgii:auth_skipped", "1");
              return document.readyState !== "loading" &&
                document.querySelector("#root")?.childElementCount > 0;
            } catch {
              return false;
            }
          `,
          []
        ),
      {
        timeout: WAIT_MS,
        interval: 250,
        timeoutMsg: "app root never mounted",
      }
    );
  });

  it("handles the native-menu bridge, then survives reload", async () => {
    await browser.executeScript(
      `
        window.dispatchEvent(new CustomEvent("menu-reopen-setup"));
      `,
      []
    );

    await browser.waitUntil(setupPreferencesVisible, {
      timeout: WAIT_MS,
      interval: 200,
      timeoutMsg: "setup menu bridge did not open quick preferences",
    });
    const firstPath = await browser.executeScript(
      "return window.location.pathname;",
      []
    );
    if (firstPath !== "/orgii/app/walkthrough") {
      throw new Error(`shortcut opened unexpected route: ${firstPath}`);
    }

    await browser.refresh();
    await browser.waitUntil(setupPreferencesVisible, {
      timeout: WAIT_MS,
      interval: 200,
      timeoutMsg: "shortcut-reset onboarding state did not survive reload",
    });
  });
});
