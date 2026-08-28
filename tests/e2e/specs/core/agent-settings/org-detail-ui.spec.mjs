/* global describe, before, it */
import {
  bootAgentSettingsE2E,
  pointerClick,
  setTextInput,
  waitForScript,
} from "../../../support/core/agent-settings/agentSettingsDriver.mjs";
import {
  createRenderedStrictTwoMemberAgentOrg,
  invokeE2E,
  removeAgentOrgsByName,
  unwrap,
  waitForAgentOrgByName,
} from "../../../support/core/agentOrgUiDriver.mjs";

const RUN_MARKER = `E2E_ORG_DETAIL_${Date.now()}`;
const ORGS_ROUTE = "/orgii/app/settings/agent-orgs/orgs";
async function openOrgDetail(orgId, label, displayName) {
  unwrap(
    await invokeE2E("openOrgTab", orgId, displayName),
    `open org tab for ${label}`
  );
  await restoreWorkstationIfFocused(orgId, `${label} open org detail`);
  let tabRenderState = null;
  try {
    await browser.waitUntil(
      async () => {
        tabRenderState = await browser.executeScript(
          `
            const root = document.querySelector('[data-testid="agent-config-tab-org-${orgId}"]');
            const describe = (element) => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              return {
                tag: element.tagName,
                testId: element.getAttribute?.('data-testid') || null,
                className: typeof element.className === 'string' ? element.className.slice(0, 160) : null,
                rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
                display: style.display,
                visibility: style.visibility,
                text: element.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 240) ?? '',
              };
            };
            const shell = document.querySelector('.work-station-shell');
            const grid = document.querySelector('.work-station-shell__grid');
            const mainContent = document.querySelector('.work-station-shell__grid-content');
            const chatMaximized = localStorage.getItem('orgii:chatPanelMaximized');
            const stationVisibility = localStorage.getItem('stationChatVisibility');
            const layoutStorage = localStorage.getItem('orgii:workstation:tabs:v1');
            const dataTestIds = Array.from(document.querySelectorAll('[data-testid]')).map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                id: el.getAttribute('data-testid'),
                rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
                text: el.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 120) ?? '',
              };
            }).slice(-80);
            return {
              ok: !!root && root.getBoundingClientRect().width > 0 && root.getBoundingClientRect().height > 0,
              location: window.location.pathname,
              root: describe(root),
              shell: describe(shell),
              grid: describe(grid),
              mainContent: describe(mainContent),
              chatMaximized,
              stationVisibility,
              layoutStorage: layoutStorage?.slice(0, 1000) ?? null,
              bodyText: document.body.innerText.slice(0, 1500),
              dataTestIds,
            };
          `,
          []
        );
        return tabRenderState?.ok === true;
      },
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `${label} org config tab did not render visibly`,
      }
    );
  } catch (error) {
    throw new Error(
      `${label} org config tab did not render visibly: ${JSON.stringify(tabRenderState, null, 2)}`,
      { cause: error }
    );
  }
  let formRenderState = null;
  try {
    await browser.waitUntil(
      async () => {
        formRenderState = await browser.executeScript(
          `
            const root = document.querySelector('[data-testid="agent-config-tab-org-${orgId}"] [data-testid="agent-orgs-org-detail"]');
            const input = root?.querySelector('[data-testid="agent-orgs-org-name-input"]') ?? null;
            const rect = input?.getBoundingClientRect?.() ?? null;
            const style = input ? window.getComputedStyle(input) : null;
            return {
              ok: !!input && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
              rect: rect ? { width: rect.width, height: rect.height, left: rect.left, top: rect.top } : null,
              rootRect: root ? (() => { const r = root.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, top: r.top }; })() : null,
              text: root?.textContent?.slice(0, 500) ?? '',
              testIds: root ? Array.from(root.querySelectorAll('[data-testid]')).map((el) => {
                const r = el.getBoundingClientRect();
                return { id: el.getAttribute('data-testid'), width: r.width, height: r.height, text: el.textContent?.trim().slice(0, 80) ?? '' };
              }).slice(0, 80) : [],
              location: window.location.pathname,
            };
          `,
          []
        );
        return formRenderState?.ok === true;
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: `${label} org detail form did not render visibly`,
      }
    );
  } catch (error) {
    throw new Error(
      `${label} org detail form did not render visibly: ${JSON.stringify(formRenderState)}`,
      { cause: error }
    );
  }
}

async function restoreWorkstationIfFocused(orgId, label) {
  const restoreTarget = `e2e-restore-workstation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = await browser.executeScript(
    `
      const orgRoot = document.querySelector('[data-testid="agent-config-tab-org-${orgId}"]');
      const rect = orgRoot?.getBoundingClientRect?.() ?? null;
      if (rect && rect.width > 0 && rect.height > 0) return { needed: false, width: rect.width };
      document.querySelectorAll('[data-e2e-restore-workstation-target]').forEach((element) => {
        element.removeAttribute('data-e2e-restore-workstation-target');
      });
      const candidates = Array.from(document.querySelectorAll('button[aria-label]')).filter((button) => {
        const label = button.getAttribute('aria-label') || '';
        const buttonRect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        return /Workstation|工作站/.test(label) && buttonRect.width > 0 && buttonRect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      const button = candidates[0] ?? null;
      if (!button) {
        return {
          needed: true,
          foundButton: false,
          width: rect?.width ?? null,
          labels: Array.from(document.querySelectorAll('button[aria-label]')).map((item) => item.getAttribute('aria-label')).slice(0, 80),
        };
      }
      button.setAttribute('data-e2e-restore-workstation-target', arguments[0]);
      return { needed: true, foundButton: true, label: button.getAttribute('aria-label'), width: rect?.width ?? null };
    `,
    [restoreTarget]
  );
  if (state?.needed !== true) return;
  if (state?.foundButton !== true) {
    throw new Error(
      `${label} needed Workstation restore but no visible restore button was found: ${JSON.stringify(state)}`
    );
  }
  await pointerClick(
    `[data-e2e-restore-workstation-target="${restoreTarget}"]`,
    `${label} restore Workstation button`
  );
  await waitForScript(
    `const root = document.querySelector('[data-testid="agent-config-tab-org-${orgId}"]'); const rect = root?.getBoundingClientRect?.(); return !!rect && rect.width > 0 && rect.height > 0;`,
    `${label} Workstation did not become visible after restore`,
    30_000
  );
}

async function waitForOrgDeleted(orgId, label) {
  await browser.waitUntil(
    async () => {
      const orgs = unwrap(
        await invokeE2E("listAgentOrgs"),
        `poll orgs after ${label}`
      ).orgs;
      return !(orgs ?? []).some((org) => org?.id === orgId);
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} org was not deleted`,
    }
  );
}

describe("Agent Org detail Settings UI", () => {
  before(async () => {
    await bootAgentSettingsE2E();
  });

  it("reverts cancelled org detail edits and persists saved org detail edits", async () => {
    const originalName = `E2E Detail Org ${RUN_MARKER}`;
    const leadName = `E2E Detail Lead ${RUN_MARKER}`;
    const childName = `E2E Detail Child ${RUN_MARKER}`;
    const cancelledName = `E2E Cancelled Detail Org ${RUN_MARKER}`;
    const savedName = `E2E Saved Detail Org ${RUN_MARKER}`;
    const savedDescription = `Saved org detail description ${RUN_MARKER}`;
    const addedMemberName = `E2E Detail Added ${RUN_MARKER}`;
    const addedMemberRole = "Reviewer";

    try {
      await removeAgentOrgsByName(originalName);
      await removeAgentOrgsByName(cancelledName);
      await removeAgentOrgsByName(savedName);
      const org = await createRenderedStrictTwoMemberAgentOrg({
        orgName: originalName,
        leadName,
        childName,
      });

      await openOrgDetail(org.id, "created org", originalName);
      const orgTabSelector = `[data-testid="agent-config-tab-org-${org.id}"]`;
      await setTextInput(
        `${orgTabSelector} [data-testid="agent-orgs-org-detail"] [data-testid="agent-orgs-org-name-input"]`,
        cancelledName,
        "org detail cancelled name"
      );
      await waitForScript(
        `return document.querySelector(arguments[0] + ' [data-testid="agent-orgs-org-detail"]')?.getAttribute('data-dirty') === 'true';`,
        "org detail did not become dirty after cancelled name edit",
        30_000,
        [orgTabSelector]
      );
      await restoreWorkstationIfFocused(org.id, "org detail cancel");
      await pointerClick(
        `${orgTabSelector} [data-testid="agent-orgs-org-detail-cancel-button"]`,
        "org detail cancel button"
      );
      await waitForScript(
        `return document.querySelector(arguments[0] + ' [data-testid="agent-orgs-org-detail"] [data-testid="agent-orgs-org-name-input"]')?.value === arguments[1];`,
        "org detail cancel did not revert name input",
        30_000,
        [orgTabSelector, originalName]
      );
      const afterCancel = unwrap(
        await invokeE2E("listAgentOrgs"),
        "list orgs after cancel"
      ).orgs;
      if ((afterCancel ?? []).some((item) => item.name === cancelledName)) {
        throw new Error(
          `Cancelled org detail edit persisted: ${JSON.stringify(afterCancel)}`
        );
      }

      await setTextInput(
        `${orgTabSelector} [data-testid="agent-orgs-org-detail"] [data-testid="agent-orgs-org-name-input"]`,
        savedName,
        "org detail saved name"
      );
      await setTextInput(
        `${orgTabSelector} [data-testid="agent-orgs-org-detail"] [data-testid="agent-orgs-org-description-input"]`,
        savedDescription,
        "org detail saved description"
      );
      await pointerClick(
        `${orgTabSelector} [data-testid="agent-orgs-member-add-member-button"]`,
        "org detail add member button"
      );
      await waitForScript(
        `return Array.from(document.querySelectorAll(arguments[0] + ' [data-testid^="agent-orgs-member-"][data-testid$="-name-input"]')).some((input) => input.value === '');`,
        "new org detail member name input did not render",
        30_000,
        [orgTabSelector]
      );
      const addedMemberNameInputTestId = await browser.executeScript(
        `
          const inputs = Array.from(document.querySelectorAll(arguments[0] + ' [data-testid^="agent-orgs-member-"][data-testid$="-name-input"]'));
          const nameInput = inputs.find((input) => input.value === '');
          return nameInput?.getAttribute('data-testid') ?? null;
        `,
        [orgTabSelector]
      );
      if (!addedMemberNameInputTestId) {
        throw new Error(
          "new org detail member name input test id was not found"
        );
      }
      const addedMemberRoleInputTestId = addedMemberNameInputTestId.replace(
        "-name-input",
        "-role-input"
      );
      await setTextInput(
        `${orgTabSelector} [data-testid="${addedMemberNameInputTestId}"]`,
        addedMemberName,
        "org detail added member name"
      );
      await setTextInput(
        `${orgTabSelector} [data-testid="${addedMemberRoleInputTestId}"]`,
        addedMemberRole,
        "org detail added member role"
      );
      let savedEditState = null;
      try {
        await browser.waitUntil(
          async () => {
            savedEditState = await browser.executeScript(
              `
                const root = document.querySelector(arguments[0] + ' [data-testid="agent-orgs-org-detail"]');
                const inputValue = (testId) => root?.querySelector('[data-testid="' + testId + '"]')?.value ?? null;
                const memberInputs = root ? Array.from(root.querySelectorAll('[data-testid^="agent-orgs-member-"]')).map((element) => ({
                  testId: element.getAttribute('data-testid'),
                  value: element.value ?? null,
                  text: element.textContent?.trim().slice(0, 120) ?? null,
                })) : [];
                return {
                  dirty: root?.getAttribute('data-dirty') ?? null,
                  valid: root?.getAttribute('data-valid') ?? null,
                  name: inputValue('agent-orgs-org-name-input'),
                  description: inputValue('agent-orgs-org-description-input'),
                  coordinator: root?.querySelector('[data-testid="agent-orgs-org-coordinator-select"]')?.textContent?.trim() ?? null,
                  hierarchy: root?.querySelector('[data-testid="agent-orgs-hierarchy-mode-select"]')?.textContent?.trim() ?? null,
                  memberInputs,
                  rootText: root?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 800) ?? null,
                };
              `,
              [orgTabSelector]
            );
            return (
              savedEditState?.dirty === "true" &&
              savedEditState?.valid === "true"
            );
          },
          {
            timeout: 30_000,
            interval: 250,
            timeoutMsg:
              "org detail did not become valid dirty after saved edits",
          }
        );
      } catch (error) {
        throw new Error(
          `org detail did not become valid dirty after saved edits: ${JSON.stringify(savedEditState)}`,
          { cause: error }
        );
      }
      await restoreWorkstationIfFocused(org.id, "org detail save");
      await pointerClick(
        `${orgTabSelector} [data-testid="agent-orgs-org-detail-save-button"]`,
        "org detail save button"
      );
      const savedOrg = await waitForAgentOrgByName(
        savedName,
        "saved org detail edit"
      );
      if (savedOrg.description !== savedDescription) {
        throw new Error(
          `Saved org detail description mismatch: ${JSON.stringify(savedOrg)}`
        );
      }
      const savedLead = (savedOrg.children ?? []).find(
        (member) => member.name === leadName
      );
      const savedChild = savedLead?.children?.find(
        (member) => member.name === childName
      );
      const savedAddedMember = (savedOrg.children ?? []).find(
        (member) => member.name === addedMemberName
      );
      if (
        !savedLead ||
        !savedChild ||
        !savedAddedMember ||
        savedAddedMember.role !== addedMemberRole ||
        savedOrg.hierarchyMode !== "strict"
      ) {
        throw new Error(
          `Saved org detail clobbered topology: ${JSON.stringify(savedOrg)}`
        );
      }
      unwrap(
        await invokeE2E("navigateTo", ORGS_ROUTE),
        "navigate to orgs after org detail save"
      );
      await waitForScript(
        `
          const row = document.querySelector('[data-testid="agent-orgs-org-row-' + arguments[0] + '"]');
          return !!row && /\\b4\\b/.test(row.textContent || '');
        `,
        "org table member count did not refresh after detail save",
        30_000,
        [org.id]
      );
    } finally {
      await removeAgentOrgsByName(originalName);
      await removeAgentOrgsByName(cancelledName);
      await removeAgentOrgsByName(savedName);
    }
  });

  it("deletes an org through the table Delete action", async () => {
    const orgName = `E2E Table Delete Org ${RUN_MARKER}`;
    const leadName = `E2E Table Delete Lead ${RUN_MARKER}`;
    const childName = `E2E Table Delete Child ${RUN_MARKER}`;

    try {
      await removeAgentOrgsByName(orgName);
      const org = await createRenderedStrictTwoMemberAgentOrg({
        orgName,
        leadName,
        childName,
      });

      unwrap(
        await invokeE2E("navigateTo", ORGS_ROUTE),
        "navigate to orgs before table delete"
      );
      await waitForScript(
        `return !!document.querySelector('[data-testid="agent-orgs-org-delete-row-button-${org.id}"]');`,
        "org table delete action did not render"
      );
      await browser.executeScript(
        `window.__orgiiE2EAutoConfirmDestructive = true; return true;`,
        []
      );
      try {
        await pointerClick(
          `[data-testid="agent-orgs-org-delete-row-button-${org.id}"]`,
          "org table delete action"
        );
        await waitForOrgDeleted(org.id, "table Delete action");
      } finally {
        await browser.executeScript(
          `delete window.__orgiiE2EAutoConfirmDestructive; return true;`,
          []
        );
      }
    } finally {
      await removeAgentOrgsByName(orgName);
    }
  });
});
