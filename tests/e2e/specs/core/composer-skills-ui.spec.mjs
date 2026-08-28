import fs from "node:fs";
import path from "node:path";

import {
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const WORKSTATION_CODE_PATH = "/orgii/workstation/code";

const INPUT_SELECTOR = '[data-testid="chat-input"] [contenteditable="true"]';
const PREFIX = `ORGII_SKILL_PREFIX_${Date.now()}`;
const INLINE_PREFIX = `ORGII_INLINE_SKILL_PREFIX_${Date.now()}`;
const WORKSPACE_RULE_NAME = `e2e-workspace-context-rule-${Date.now()}`;
const PERSONAL_RULE_NAME = `e2e-prompt-loop-rule-${Date.now()}`;
const workspaceRuleBody = `${WORKSPACE_RULE_NAME}\n`.repeat(80);
const personalRuleBody = `${PERSONAL_RULE_NAME}\n`.repeat(240);

async function execJS(script) {
  return browser.executeScript(script, []);
}

const js = {
  type: (selector, text) => `
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return "missing";
    editor.focus();
    const ok = document.execCommand("insertText", false, ${JSON.stringify(text)});
    return ok ? "typed" : "insert-failed";
  `,
  text: (selector) => `
    const editor = document.querySelector(${JSON.stringify(selector)});
    return editor ? (editor.textContent || "") : null;
  `,
  clear: (selector) => `
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return "missing";
    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    return editor.textContent || "";
  `,
  click: (selector) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    element.click();
    return "clicked";
  `,
  focus: (selector) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    element.focus();
    return document.activeElement === element ? "focused" : "focus-failed";
  `,
  setSlashSearch: (query) => `
    const input = document.querySelector('[data-slash-search-input="true"]');
    if (!input) return "missing";
    input.focus();
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(query)} }));
    return "typed";
  `,
  clickSkill: (name) => `
    const row = document.querySelector(
      '[data-testid="slash-command-item"][data-slash-category="skill"][data-slash-name="' + CSS.escape(${JSON.stringify(name)}) + '"]'
    );
    if (!row) return "missing";
    const target = row.firstElementChild || row;
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    target.click();
    return "clicked";
  `,
  contextRuleNames: () => `
    return Array.from(document.querySelectorAll('[data-testid="context-info-rule"]'))
      .map((row) => row.getAttribute('data-rule-name') || row.textContent || '');
  `,
  contextCategoryText: (key) => `
    const row = document.querySelector('[data-testid="context-info-category-' + CSS.escape(${JSON.stringify(key)}) + '"]');
    return row ? (row.textContent || '') : null;
  `,
  contextPanelText: () => `
    const panel = document.querySelector('[data-testid="context-info-panel"]');
    return panel ? (panel.textContent || '') : null;
  `,
};

describe("Composer skills menu", () => {
  before(async () => {
    await waitForApp();
    const repoPath = process.env.E2E_REPO_PATH;
    const orgiiHome = process.env.ORGII_HOME;
    if (!repoPath) throw new Error("E2E_REPO_PATH missing");
    if (!orgiiHome) throw new Error("ORGII_HOME missing");

    fs.mkdirSync(path.join(repoPath, ".orgii", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, ".orgii", "rules", `${WORKSPACE_RULE_NAME}.md`),
      workspaceRuleBody
    );
    fs.mkdirSync(path.join(orgiiHome, "personal", "rules"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(orgiiHome, "personal", "rules", `${PERSONAL_RULE_NAME}.md`),
      personalRuleBody
    );

    unwrap(
      await invokeE2E("navigateTo", WORKSTATION_CODE_PATH),
      "navigateTo workstation code"
    );
    unwrap(
      await invokeE2E("ensureRepoSelected", {
        repoPath,
        repoName: path.basename(repoPath),
      }),
      "ensureRepoSelected"
    );
    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
  });

  after(() => {
    const repoPath = process.env.E2E_REPO_PATH;
    const orgiiHome = process.env.ORGII_HOME;
    if (repoPath) {
      fs.rmSync(
        path.join(repoPath, ".orgii", "rules", `${WORKSPACE_RULE_NAME}.md`),
        {
          force: true,
        }
      );
    }
    if (orgiiHome) {
      fs.rmSync(
        path.join(orgiiHome, "personal", "rules", `${PERSONAL_RULE_NAME}.md`),
        {
          force: true,
        }
      );
    }
  });

  it("preserves existing text when selecting a skill from the + menu search", async () => {
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector(${JSON.stringify(INPUT_SELECTOR)});`
        ),
      {
        timeout: 60_000,
        timeoutMsg: "chat input never mounted",
      }
    );

    expect(await execJS(js.clear(INPUT_SELECTOR))).toBe("");
    expect(await execJS(js.type(INPUT_SELECTOR, PREFIX))).toBe("typed");
    expect(
      await execJS(js.click('[data-testid="composer-skills-tools-button"]'))
    ).toBe("clicked");

    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-slash-search-input="true"]');`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "slash command search input never mounted",
      }
    );

    expect(await execJS(js.setSlashSearch("manage-skills"))).toBe("typed");

    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-testid="slash-command-item"][data-slash-category="skill"][data-slash-name="manage-skills"]');`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "manage-skills row never appeared",
      }
    );

    expect(await execJS(js.clickSkill("manage-skills"))).toBe("clicked");

    await browser.waitUntil(
      async () => {
        const text = await execJS(js.text(INPUT_SELECTOR));
        return (
          typeof text === "string" &&
          text.includes(PREFIX) &&
          text.includes("manage-skills")
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: `composer did not preserve prefix and append skill; text=${JSON.stringify(await execJS(js.text(INPUT_SELECTOR)))}`,
      }
    );
  });

  it("preserves existing text when selecting a skill from the inline slash menu", async () => {
    const inlineDraft = `${INLINE_PREFIX} 你能走 e2e 验证你的变动 然后我发现多个 bug `;

    expect(await execJS(js.clear(INPUT_SELECTOR))).toBe("");
    expect(await execJS(js.type(INPUT_SELECTOR, inlineDraft))).toBe("typed");
    expect(await execJS(js.focus(INPUT_SELECTOR))).toBe("focused");

    await browser.keys("/");

    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-testid="slash-command-menu"]');`
        ),
      {
        timeout: 10_000,
        timeoutMsg:
          "inline slash command menu never opened after keyboard slash",
      }
    );

    await browser.keys("manage");

    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-testid="slash-command-item"][data-slash-category="skill"][data-slash-name="manage-skills"]');`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "inline manage-skills row never appeared",
      }
    );

    expect(await execJS(js.clickSkill("manage-skills"))).toBe("clicked");

    await browser.waitUntil(
      async () => {
        const text = await execJS(js.text(INPUT_SELECTOR));
        return (
          typeof text === "string" &&
          text.includes(INLINE_PREFIX) &&
          text.includes("你能走 e2e 验证你的变动") &&
          !text.includes("/manage") &&
          text.includes("manage-skills")
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: `inline slash selection did not preserve prefix and append skill; text=${JSON.stringify(await execJS(js.text(INPUT_SELECTOR)))}`,
      }
    );
  });

  it("renders backend-provided contextUsage sections in the context popover", async () => {
    const sessionId = `e2e-composer-context-${Date.now()}`;
    unwrap(
      await invokeE2E("seedChatEvents", sessionId, [
        {
          id: `${sessionId}-user`,
          chunk_id: `${sessionId}-user`,
          sessionId,
          actionType: "message",
          functionName: "message",
          uiCanonical: "message",
          source: "user",
          displayText: "Context popover test",
          content: "Context popover test",
          createdAt: new Date().toISOString(),
          displayStatus: "completed",
          displayVariant: "message",
          activityStatus: "processed",
        },
      ]),
      "seedChatEvents context info"
    );
    unwrap(
      await invokeE2E("openSession", sessionId),
      "openSession context info"
    );
    unwrap(
      await invokeE2E("seedSessionContextUsage", {
        usedTokens: 12000,
        maxTokens: 24000,
        percentUsed: 50,
        updatedAt: new Date().toISOString(),
        warnings: ["backend context usage warning sentinel"],
        sections: [
          {
            category: "rules",
            label: "Rules",
            estimatedTokens: 3000,
            percent: 25,
            isEstimated: true,
            items: [
              {
                label: "backend-workspace-rule-sentinel",
                source: "workspace_rules",
                estimatedTokens: 3000,
                details: "from backend snapshot",
              },
            ],
          },
          {
            category: "conversation",
            label: "Conversation",
            estimatedTokens: 9000,
            percent: 75,
            isEstimated: true,
            items: [
              {
                label: "backend-conversation-sentinel",
                source: "messages",
                estimatedTokens: 9000,
                details: "from backend snapshot",
              },
            ],
          },
        ],
      }),
      "seedSessionContextUsage"
    );

    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-testid="context-info-button"]');`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "context info button never rendered",
      }
    );

    expect(await execJS(js.click('[data-testid="context-info-button"]'))).toBe(
      "clicked"
    );

    await browser.waitUntil(
      async () => {
        const text = await execJS(js.contextPanelText());
        return (
          typeof text === "string" &&
          text.includes("Rules") &&
          text.includes("Conversation")
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: `backend context usage did not render in context popover; panel=${JSON.stringify(await execJS(js.contextPanelText()))}`,
      }
    );

    const rulesRow = await execJS(js.contextCategoryText("rules"));
    const conversationRow = await execJS(
      js.contextCategoryText("conversation")
    );
    const panelText = await execJS(js.contextPanelText());

    expect(rulesRow).toEqual(expect.stringContaining("Rules"));
    expect(rulesRow).toEqual(expect.stringContaining("25%"));
    expect(rulesRow).toEqual(expect.stringContaining("3.0K"));
    expect(conversationRow).toEqual(expect.stringContaining("Conversation"));
    expect(conversationRow).toEqual(expect.stringContaining("75%"));
    expect(conversationRow).toEqual(expect.stringContaining("9.0K"));
    expect(panelText).not.toEqual(
      expect.stringContaining("backend context usage warning sentinel")
    );
    expect(panelText).not.toEqual(
      expect.stringContaining("backend-workspace-rule-sentinel")
    );
    expect(panelText).not.toEqual(
      expect.stringContaining("backend-conversation-sentinel")
    );

    const ruleNames = await execJS(js.contextRuleNames());
    expect(ruleNames).toEqual([]);
  });
});
