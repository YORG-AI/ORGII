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

  it("gives + and @ the same searchable, keyboard-navigable mode menu", async () => {
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
      await execJS(js.click('[data-testid="composer-add-context-button"]'))
    ).toBe("clicked");

    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-context-menu-portal]');`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "context action menu never mounted from +",
      }
    );

    const readMenuContract = () =>
      execJS(`
        return {
          hasSearchInput: !!document.querySelector('[data-context-menu-portal] [data-testid="context-menu-search-input"]'),
          hasUpload: !!document.querySelector('[data-context-menu-portal] [data-testid="context-menu-image-upload"]'),
          modes: Array.from(document.querySelectorAll('[data-context-menu-portal] [data-testid^="context-menu-mode-option-"]'))
            .map((row) => row.getAttribute('data-testid')),
          slashMenu: !!document.querySelector('[data-testid="slash-command-menu"]'),
          skillRows: document.querySelectorAll('[data-testid="slash-command-item"][data-slash-category="skill"]').length,
        };
      `);
    const plusContract = await readMenuContract();
    expect(plusContract).toEqual({
      hasSearchInput: false,
      hasUpload: true,
      modes: [
        "context-menu-mode-option-build",
        "context-menu-mode-option-plan",
        "context-menu-mode-option-ask",
        "context-menu-mode-option-project",
      ],
      slashMenu: false,
      skillRows: 0,
    });
    expect(await execJS(js.text(INPUT_SELECTOR))).toBe(PREFIX);

    await browser.keys("plan");
    await browser.waitUntil(
      async () =>
        execJS(`
          return !!document.querySelector('[data-testid="context-menu-mode-option-plan"]') &&
            !document.querySelector('[data-testid="context-menu-mode-option-build"]');
        `),
      {
        timeout: 10_000,
        timeoutMsg: "composer-owned menu query did not filter to Plan mode",
      }
    );
    await browser.keys("Enter");
    await browser.waitUntil(
      async () =>
        execJS(`return !document.querySelector('[data-context-menu-portal]');`),
      {
        timeout: 5_000,
        timeoutMsg: "keyboard mode selection did not close the shared menu",
      }
    );
    expect(await execJS(js.text(INPUT_SELECTOR))).toBe(PREFIX);

    expect(
      await execJS(js.click('[data-testid="composer-add-context-button"]'))
    ).toBe("clicked");
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-testid="context-menu-mode-option-plan"] [data-icon="check"]');`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "Plan mode was not selected from the shared menu",
      }
    );

    await browser.keys("Escape");
    await browser.waitUntil(
      async () =>
        execJS(`return !document.querySelector('[data-context-menu-portal]');`),
      {
        timeout: 5_000,
        timeoutMsg: "context action menu did not close",
      }
    );

    expect(await execJS(js.focus(INPUT_SELECTOR))).toBe("focused");
    await browser.keys("@");
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-context-menu-portal]') && document.activeElement?.matches(${JSON.stringify(INPUT_SELECTOR)}) === true;`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "@ menu did not keep composer focus",
      }
    );
    expect(await readMenuContract()).toEqual(plusContract);
    await browser.keys("Escape");

    expect(await execJS(js.clear(INPUT_SELECTOR))).toBe("");
    expect(await execJS(js.focus(INPUT_SELECTOR))).toBe("focused");
    await browser.keys("/");
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-testid="slash-command-menu"]');`
        ),
      {
        timeout: 10_000,
        timeoutMsg: "slash menu did not open",
      }
    );
    await browser.keys("@");
    await browser.waitUntil(
      async () =>
        execJS(`
          return !!document.querySelector('[data-context-menu-portal]') &&
            !document.querySelector('[data-testid="slash-command-menu"]');
        `),
      {
        timeout: 10_000,
        timeoutMsg: "opening @ did not close the slash menu",
      }
    );
    await browser.keys("Escape");
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
