/* global describe, before, it, browser */
/**
 * Routine wizard + Routines page rendered-UI coverage.
 *
 * Runtime contracts for the Routine × Work Item architecture live in
 * `work-item-durable-object.spec.mjs` (fires, concurrency policies,
 * create-work-item contract). This spec covers the RENDERED UI layer:
 *
 * 1. Routine wizard opens from the Routines settings page, the new
 *    output-policy section (output mode / concurrency / catch-up) and
 *    the visual cron builder render, and a save through the real
 *    Save button persists a routine whose outputPolicy matches the
 *    selections made by clicking rendered controls.
 * 2. The cron builder produces a real cron expression from the
 *    frequency dropdown (no hand-typed cron needed), and the custom
 *    cron toggle still exposes the raw input.
 * 3. Edit mode round-trips the saved output policy back into the
 *    rendered controls.
 * 4. Fire history renders inside the expanded routine row after a
 *    manual fire (backend event → UI refresh path).
 * 5. Ghost-action negative: the Work Item ScheduleEditor no longer
 *    offers "Recurring" for new schedules (recurring moved to
 *    Routines); a legacy cron value still renders read-back.
 * 6. Work Item detail shows the routine-source chip for items created
 *    by a routine fire.
 */
import { waitForApp } from "../../support/core/session/agentPlanFollowupScenarios.mjs";

const RUN_ID = Date.now();
const RENDER_TIMEOUT_MS = 20_000;
const MOUNT_TIMEOUT_MS = 30_000;

const ROUTINES_ROUTE = "/orgii/app/settings/integrations/routines";

const SCENARIO_FILTER = (process.env.E2E_ROUTINE_UI_SCENARIOS ?? "")
  .split(",")
  .map((scenario) => scenario.trim())
  .filter(Boolean);

const WIZARD_SAVE_SCENARIO = "routine-wizard-save-output-policy";
const WIZARD_EDIT_ROUNDTRIP_SCENARIO = "routine-wizard-edit-roundtrip";
const FIRE_HISTORY_SCENARIO = "routine-fire-history-expanded-row";
const SCHEDULE_RECURRING_REMOVED_SCENARIO =
  "work-item-schedule-recurring-removed";
const ROUTINE_SOURCE_CHIP_SCENARIO = "work-item-routine-source-chip";

function shouldRunScenario(name) {
  return SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
}

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function invokeE2E(method, ...args) {
  const envelope = await browser.executeAsyncScript(
    `
    const cb = arguments[arguments.length - 1];
    const method = arguments[0];
    const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
    if (!window.__e2e || typeof window.__e2e[method] !== "function") {
      cb({ e2eResult: { ok: false, error: "window.__e2e." + method + " not available" } });
      return;
    }
    Promise.resolve(window.__e2e[method].apply(null, rest))
      .then((result) => cb({ e2eResult: result }))
      .catch((error) => cb({ e2eResult: { ok: false, error: String(error && error.message || error) } }));
  `,
    [method, ...args]
  );
  return (
    envelope?.e2eResult ?? {
      ok: false,
      error: "invokeE2E returned no envelope",
    }
  );
}

function unwrap(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${result?.error ?? "unknown"}`);
  }
  return result;
}

async function clickSelector(selector) {
  return execJS(`
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const element = elements.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (!element) return elements.length > 0 ? "hidden" : "missing";
    if (element.disabled) return "disabled";
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return "clicked";
  `);
}

async function waitForSelector(selector, label, timeout = RENDER_TIMEOUT_MS) {
  await browser.waitUntil(
    async () =>
      execJS(
        `return Boolean(document.querySelector(${JSON.stringify(selector)}));`
      ),
    { timeout, interval: 250, timeoutMsg: `${label} never rendered` }
  );
}

async function clickWhenRendered(selector, label, timeout = RENDER_TIMEOUT_MS) {
  await waitForSelector(selector, label, timeout);
  let result = null;
  await browser.waitUntil(
    async () => {
      result = await clickSelector(selector);
      return result === "clicked";
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${label} did not click: ${JSON.stringify(result)}`,
    }
  );
}

/** Open a Select dropdown by trigger testid and click the option testid. */
async function selectRenderedOption(triggerTestId, optionTestId, label) {
  await clickWhenRendered(
    `[data-testid="${triggerTestId}"]`,
    `${label} trigger`
  );
  await clickWhenRendered(`[data-testid="${optionTestId}"]`, `${label} option`);
}

async function setInputValue(selector, value, label) {
  const result = await execJS(`
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return "missing";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (!setter) return "no-setter";
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value;
  `);
  if (result !== value) {
    throw new Error(
      `${label} input did not accept value: ${JSON.stringify(result)}`
    );
  }
}

async function setTextareaValue(selector, value, label) {
  const result = await execJS(`
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return "missing";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return "no-setter";
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value;
  `);
  if (result !== value) {
    throw new Error(
      `${label} textarea did not accept value: ${JSON.stringify(result)}`
    );
  }
}

async function openRoutinesPage() {
  unwrap(
    await invokeE2E("navigateTo", ROUTINES_ROUTE),
    "navigateTo(routines settings page)"
  );
  await waitForSelector(
    '[data-testid^="integrations-routine-row-"], [data-testid="routine-wizard-root"], [data-testid="settings-table-empty"], table',
    "Routines settings surface"
  );
}

async function openAddRoutineWizard() {
  unwrap(
    await invokeE2E("navigateTo", `${ROUTINES_ROUTE}?wizard=routine-add`),
    "navigateTo(routine add wizard)"
  );
  await waitForSelector(
    '[data-testid="routine-wizard-root"]',
    "Routine wizard root"
  );
}

/**
 * Fill the minimum required wizard fields (name / agent / prompt) so the
 * Save button enables. Agent selection goes through the rendered
 * DispatchCategoryPalette using the builtin:sde row.
 */
async function fillRequiredWizardFields(name, prompt) {
  await setInputValue(
    '[data-testid="routine-wizard-name-input"] input, input[data-testid="routine-wizard-name-input"]',
    name,
    "Routine name"
  );

  await clickWhenRendered(
    '[data-testid="routine-wizard-agent-trigger"]',
    "Agent responsible trigger"
  );
  await clickWhenRendered(
    '[data-testid="session-creator-agent-option-def-builtin:sde"]',
    "builtin:sde agent option",
    MOUNT_TIMEOUT_MS
  );

  await setTextareaValue(
    '[data-testid="routine-wizard-prompt-input"] textarea, textarea[data-testid="routine-wizard-prompt-input"]',
    prompt,
    "Routine prompt"
  );
}

async function findRoutineByName(name, label) {
  const listed = unwrap(await invokeE2E("listRoutines"), label);
  return (listed.routines ?? []).find((routine) => routine.name === name);
}

describe("Routine wizard and Routines page rendered UI", function () {
  this.timeout(300_000);

  before(async function () {
    await waitForApp();
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!(window.__e2e && window.__e2e.navigateTo && window.__e2e.listRoutines && window.__e2e.upsertRoutine && window.__e2e.deleteRoutine && window.__e2e.fireRoutine && window.__e2e.listRoutineFires && window.__e2e.allocateStandaloneWorkItemId && window.__e2e.writeStandaloneWorkItem && window.__e2e.readStandaloneWorkItem && window.__e2e.openWorkspaceWorkItemsTab);`
        ),
      {
        timeout: MOUNT_TIMEOUT_MS,
        timeoutMsg: "window.__e2e routine helpers never became available",
      }
    );
  });

  it("creates a routine through the rendered wizard with cron builder and output policy controls", async function () {
    if (!shouldRunScenario(WIZARD_SAVE_SCENARIO)) {
      this.skip();
      return;
    }

    const routineName = `E2E UI routine ${RUN_ID}`;
    let createdRoutineId = null;
    try {
      await openRoutinesPage();
      await openAddRoutineWizard();

      await fillRequiredWizardFields(
        routineName,
        "E2E rendered wizard probe. Reply with one short sentence."
      );

      // Trigger: switch to Cron via the rendered select; the builder must
      // immediately materialize a valid expression (no raw cron typed).
      await selectRenderedOption(
        "routine-wizard-trigger-select",
        "routine-wizard-trigger-option-cron",
        "Trigger kind"
      );
      await waitForSelector(
        '[data-testid="routine-wizard-cron-frequency-select"]',
        "Cron frequency builder"
      );
      await selectRenderedOption(
        "routine-wizard-cron-frequency-select",
        "routine-wizard-cron-frequency-option-weekly",
        "Cron frequency"
      );
      await waitForSelector(
        '[data-testid="routine-wizard-cron-weekday-select"]',
        "Cron weekday select"
      );

      // Custom-cron toggle still exposes the raw input (escape hatch).
      await clickWhenRendered(
        '[data-testid="routine-wizard-cron-toggle"]',
        "Custom cron toggle"
      );
      const rawCron = await execJS(`
        const input = document.querySelector('[data-testid="routine-wizard-cron-input"] input, input[data-testid="routine-wizard-cron-input"]');
        return input ? input.value : null;
      `);
      if (!rawCron || rawCron.split(/\s+/).length !== 5) {
        throw new Error(
          `Cron builder did not produce a 5-field expression: ${JSON.stringify(rawCron)}`
        );
      }
      // Back to builder mode.
      await clickWhenRendered(
        '[data-testid="routine-wizard-cron-toggle"]',
        "Custom cron toggle (back)"
      );

      // Output policy: CreateWorkItem + autoStart off + queue + skip-missed.
      await selectRenderedOption(
        "routine-wizard-output-mode-select",
        "routine-wizard-output-mode-option-create_work_item",
        "Output mode"
      );
      await waitForSelector(
        '[data-testid="routine-wizard-auto-start-switch"]',
        "Auto-start switch"
      );
      const autoStartBefore = await execJS(`
        const sw = document.querySelector('[data-testid="routine-wizard-auto-start-switch"]');
        return sw ? sw.getAttribute('aria-checked') : null;
      `);
      if (autoStartBefore !== "true") {
        throw new Error(
          `Wizard should default autoStart=true for new routines, got aria-checked=${JSON.stringify(autoStartBefore)}`
        );
      }
      await clickWhenRendered(
        '[data-testid="routine-wizard-auto-start-switch"]',
        "Auto-start switch toggle"
      );

      await selectRenderedOption(
        "routine-wizard-concurrency-select",
        "routine-wizard-concurrency-option-queue_if_active",
        "Concurrency policy"
      );
      await selectRenderedOption(
        "routine-wizard-catch-up-select",
        "routine-wizard-catch-up-option-skip_missed",
        "Catch-up policy"
      );

      // Save through the real button.
      const saveDisabled = await execJS(`
        const btn = document.querySelector('[data-testid="routine-wizard-save-button"]');
        return btn ? btn.disabled : null;
      `);
      if (saveDisabled !== false) {
        const debugState = await execJS(`
          const name = document.querySelector('[data-testid="routine-wizard-name-input"] input, input[data-testid="routine-wizard-name-input"]')?.value;
          const prompt = document.querySelector('[data-testid="routine-wizard-prompt-input"] textarea, textarea[data-testid="routine-wizard-prompt-input"]')?.value;
          const agent = document.querySelector('[data-testid="routine-wizard-agent-trigger"]')?.textContent;
          return { name, prompt, agent };
        `);
        throw new Error(
          `Save button not enabled after filling required fields: disabled=${JSON.stringify(saveDisabled)} state=${JSON.stringify(debugState)}`
        );
      }
      await clickWhenRendered(
        '[data-testid="routine-wizard-save-button"]',
        "Routine wizard save"
      );

      // Observable result: wizard closes AND the routine row renders.
      await browser.waitUntil(
        async () => {
          const wizardOpen = await execJS(
            `return Boolean(document.querySelector('[data-testid="routine-wizard-root"]'));`
          );
          return !wizardOpen;
        },
        {
          timeout: MOUNT_TIMEOUT_MS,
          timeoutMsg: "Routine wizard did not close after save",
        }
      );

      const saved = await findRoutineByName(
        routineName,
        "listRoutines(after wizard save)"
      );
      if (!saved) {
        throw new Error(
          `Saved routine "${routineName}" not found via listRoutines`
        );
      }
      createdRoutineId = saved.id;

      await waitForSelector(
        `[data-testid="integrations-routine-row-${saved.id}"]`,
        "Saved routine row",
        MOUNT_TIMEOUT_MS
      );

      // Persistence contract: the rendered selections actually round-tripped.
      if (saved.trigger?.kind !== "cron") {
        throw new Error(
          `Saved trigger should be cron: ${JSON.stringify(saved.trigger)}`
        );
      }
      if ((saved.trigger.cron ?? "").split(/\s+/).length !== 5) {
        throw new Error(
          `Saved cron should be a 5-field expression: ${JSON.stringify(saved.trigger.cron)}`
        );
      }
      const policy = saved.outputPolicy ?? {};
      const policyChecks = [
        ["mode", policy.mode, "create_work_item"],
        ["concurrencyPolicy", policy.concurrencyPolicy, "queue_if_active"],
        ["catchUpPolicy", policy.catchUpPolicy, "skip_missed"],
        ["autoStart", policy.autoStart, false],
      ];
      for (const [key, actual, expected] of policyChecks) {
        if (actual !== expected) {
          throw new Error(
            `outputPolicy.${key} did not persist from rendered controls: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)} (full: ${JSON.stringify(policy)})`
          );
        }
      }
    } finally {
      if (createdRoutineId) {
        await invokeE2E("deleteRoutine", createdRoutineId);
      }
    }
  });

  it("round-trips the saved output policy back into the rendered edit wizard", async function () {
    if (!shouldRunScenario(WIZARD_EDIT_ROUNDTRIP_SCENARIO)) {
      this.skip();
      return;
    }

    const routineName = `E2E UI edit roundtrip ${RUN_ID}`;
    const now = new Date().toISOString();
    const routine = {
      id: `e2e-ui-edit-roundtrip-${RUN_ID}`,
      name: routineName,
      description: "E2E edit-mode round-trip fixture",
      enabled: false,
      trigger: { kind: "cron", cron: "0 9 * * 1" },
      runTemplate: {
        prompt: "E2E edit roundtrip probe",
        target: { kind: "agent_definition", agentDefinitionId: "builtin:sde" },
        resources: {},
        workspace: { kind: "none" },
        mode: "ask",
        name: routineName,
      },
      outputPolicy: {
        mode: "create_work_item",
        concurrencyPolicy: "skip_if_active",
        catchUpPolicy: "run_all_limited",
        maxCatchUpRuns: 3,
        idempotencyScope: "routine_fire",
        createWorkItemStatus: "planned",
        autoStart: false,
      },
      createdAt: now,
      updatedAt: now,
    };

    try {
      unwrap(
        await invokeE2E("upsertRoutine", routine),
        "upsertRoutine(edit roundtrip fixture)"
      );

      unwrap(
        await invokeE2E(
          "navigateTo",
          `${ROUTINES_ROUTE}?wizard=routine-edit&id=${routine.id}`
        ),
        "navigateTo(routine edit wizard)"
      );
      await waitForSelector(
        '[data-testid="routine-wizard-root"]',
        "Routine edit wizard root"
      );

      let state = null;
      await browser.waitUntil(
        async () => {
          state = await execJS(`
            const name = document.querySelector('[data-testid="routine-wizard-name-input"] input, input[data-testid="routine-wizard-name-input"]')?.value ?? null;
            const outputMode = document.querySelector('[data-testid="routine-wizard-output-mode-select"]')?.textContent ?? null;
            const concurrency = document.querySelector('[data-testid="routine-wizard-concurrency-select"]')?.textContent ?? null;
            const catchUp = document.querySelector('[data-testid="routine-wizard-catch-up-select"]')?.textContent ?? null;
            const autoStart = document.querySelector('[data-testid="routine-wizard-auto-start-switch"]')?.getAttribute('aria-checked') ?? null;
            const frequency = document.querySelector('[data-testid="routine-wizard-cron-frequency-select"]')?.textContent ?? null;
            return { name, outputMode, concurrency, catchUp, autoStart, frequency };
          `);
          return state?.name === routineName;
        },
        {
          timeout: MOUNT_TIMEOUT_MS,
          timeoutMsg: `Edit wizard never loaded the routine name: ${JSON.stringify(state)}`,
        }
      );

      // The cron 0 9 * * 1 parses to weekly in the builder; the saved
      // policy enums must show their labels back in the dropdown triggers.
      const renderedChecks = [
        [
          "output mode shows CreateWorkItem",
          /work item/i.test(state.outputMode ?? ""),
        ],
        ["concurrency shows skip", /skip/i.test(state.concurrency ?? "")],
        ["catch-up shows run all", /all/i.test(state.catchUp ?? "")],
        ["autoStart switch off", state.autoStart === "false"],
        ["cron builder parsed weekly", /week/i.test(state.frequency ?? "")],
      ];
      const failures = renderedChecks.filter(([, ok]) => !ok);
      if (failures.length > 0) {
        throw new Error(
          `Edit wizard did not round-trip output policy: failed=${JSON.stringify(failures.map(([label]) => label))} state=${JSON.stringify(state)}`
        );
      }
    } finally {
      await invokeE2E("deleteRoutine", routine.id);
    }
  });

  it("renders fire history in the expanded routine row after a manual fire", async function () {
    if (!shouldRunScenario(FIRE_HISTORY_SCENARIO)) {
      this.skip();
      return;
    }

    const routineName = `E2E UI fire history ${RUN_ID}`;
    const now = new Date().toISOString();
    // `at` one hour in the FUTURE: the background RoutineScheduler will not
    // fire this fixture during the test window, so the manual fireRoutine
    // below is the only producer of history rows (manual fire ignores the
    // trigger time).
    const futureAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    // DirectSession routine with no workspace/account: fireRoutine will
    // fail to launch, but the fire row itself is durably persisted —
    // which is exactly what the expanded-row history UI must surface.
    const routine = {
      id: `e2e-ui-fire-history-${RUN_ID}`,
      name: routineName,
      description: "E2E fire history fixture",
      enabled: true,
      trigger: { kind: "one_time", at: futureAt },
      runTemplate: {
        prompt: "E2E fire history probe",
        target: { kind: "agent_definition", agentDefinitionId: "builtin:sde" },
        resources: {},
        workspace: { kind: "none" },
        mode: "ask",
        name: routineName,
      },
      outputPolicy: {
        mode: "direct_session",
        concurrencyPolicy: "always_create",
        catchUpPolicy: "skip_missed",
        maxCatchUpRuns: 1,
        idempotencyScope: "routine_fire",
        createWorkItemStatus: "planned",
        autoStart: false,
      },
      createdAt: now,
      updatedAt: now,
    };

    try {
      unwrap(
        await invokeE2E("upsertRoutine", routine),
        "upsertRoutine(fire history fixture)"
      );
      // Fire may fail at launch (no account in template) — that's fine,
      // a failed fire is still a history row. Don't unwrap.
      await invokeE2E("fireRoutine", routine.id);

      const fires = unwrap(
        await invokeE2E("listRoutineFires", routine.id),
        "listRoutineFires(fire history fixture)"
      );
      if ((fires.fires ?? []).length === 0) {
        throw new Error(
          "fireRoutine did not persist any fire row; cannot probe history UI"
        );
      }

      await openRoutinesPage();
      const rowSelector = `[data-testid="integrations-routine-row-${routine.id}"]`;
      await waitForSelector(
        rowSelector,
        "Fire history routine row",
        MOUNT_TIMEOUT_MS
      );

      // Expand via the expand-cell chevron (row click only selects).
      let expanded = false;
      await browser.waitUntil(
        async () => {
          await execJS(`
            const row = document.querySelector(${JSON.stringify(rowSelector)});
            const expander = row?.querySelector('.table-expand-cell button');
            if (expander && expander.getAttribute('aria-expanded') !== 'true') {
              expander.scrollIntoView({ block: 'center' });
              expander.click();
            }
          `);
          expanded = await execJS(
            `return Boolean(document.querySelector('[data-testid="integrations-routine-preview-${routine.id}"]'));`
          );
          return expanded;
        },
        {
          timeout: MOUNT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "Routine expanded row never rendered",
        }
      );

      // Observable result: lazily-fetched fire list renders status rows.
      let historyState = null;
      await browser.waitUntil(
        async () => {
          historyState = await execJS(`
            const history = document.querySelector('[data-testid="integrations-routine-fires-${routine.id}"]');
            const preview = document.querySelector('[data-testid="integrations-routine-preview-${routine.id}"]');
            return {
              hasHistory: Boolean(history),
              entryCount: history ? history.children.length : 0,
              previewText: (preview?.innerText ?? '').slice(0, 600),
            };
          `);
          return historyState.hasHistory && historyState.entryCount > 0;
        },
        {
          timeout: MOUNT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: `Fire history did not render in expanded row: ${JSON.stringify(historyState)}`,
        }
      );
    } finally {
      await invokeE2E("deleteRoutine", routine.id);
    }
  });

  it("no longer offers Recurring in the Work Item ScheduleEditor for new schedules", async function () {
    if (!shouldRunScenario(SCHEDULE_RECURRING_REMOVED_SCENARIO)) {
      this.skip();
      return;
    }

    const shortId = unwrap(
      await invokeE2E("allocateStandaloneWorkItemId"),
      "allocateStandaloneWorkItemId(schedule ghost-action)"
    ).shortId;
    const title = `E2E schedule ghost-action ${RUN_ID}`;
    const nowIso = new Date().toISOString();
    unwrap(
      await invokeE2E(
        "writeStandaloneWorkItem",
        shortId,
        {
          id: shortId,
          short_id: shortId,
          title,
          status: "planned",
          priority: "none",
          labels: [],
          created_by: "e2e",
          created_at: nowIso,
          updated_at: nowIso,
          starred: false,
          todos: [],
        },
        "Ghost-action probe body."
      ),
      "writeStandaloneWorkItem(schedule ghost-action)"
    );

    try {
      unwrap(
        await invokeE2E("openWorkspaceWorkItemsTab"),
        "openWorkspaceWorkItemsTab(schedule ghost-action)"
      );
      const rowSelector = `[data-testid="work-item-row-${shortId}"]`;
      await browser.waitUntil(
        async () => (await clickSelector(rowSelector)) === "clicked",
        {
          timeout: MOUNT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "Standalone work item row never became clickable",
        }
      );

      await waitForSelector(
        '[data-testid="work-item-schedule-mode-select"]',
        "Schedule mode select",
        MOUNT_TIMEOUT_MS
      );
      await clickWhenRendered(
        '[data-testid="work-item-schedule-mode-select"]',
        "Schedule mode select"
      );

      let optionState = null;
      await browser.waitUntil(
        async () => {
          optionState = await execJS(`
            const options = Array.from(document.querySelectorAll('[data-testid^="work-item-schedule-mode-option-"]'))
              .map((element) => element.getAttribute('data-testid'));
            return { options };
          `);
          return (optionState.options ?? []).length >= 2;
        },
        {
          timeout: RENDER_TIMEOUT_MS,
          timeoutMsg: `Schedule mode options never rendered: ${JSON.stringify(optionState)}`,
        }
      );

      const options = optionState.options ?? [];
      // Positive: none + one-shot still offered.
      if (
        !options.includes("work-item-schedule-mode-option-none") ||
        !options.includes("work-item-schedule-mode-option-one-shot")
      ) {
        throw new Error(
          `Schedule mode lost a supported option: ${JSON.stringify(options)}`
        );
      }
      // Ghost-action negative: recurring is gone for new schedules.
      if (options.includes("work-item-schedule-mode-option-recurring")) {
        throw new Error(
          `Recurring should not be offered for new schedules (moved to Routines): ${JSON.stringify(options)}`
        );
      }
    } finally {
      // Standalone work items have no E2E delete helper; RUN_ID-suffixed
      // fixtures are isolated per run (same convention as
      // work-item-durable-object.spec.mjs).
    }
  });

  it("shows the routine-source chip on a work item created by a routine fire", async function () {
    if (!shouldRunScenario(ROUTINE_SOURCE_CHIP_SCENARIO)) {
      this.skip();
      return;
    }

    const routineName = `E2E UI routine source ${RUN_ID}`;
    const now = new Date().toISOString();
    // Future `at`: keeps the background RoutineScheduler from racing the
    // manual fire and creating a duplicate work item (manual fire ignores
    // the trigger time).
    const futureAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const routine = {
      id: `e2e-ui-routine-source-${RUN_ID}`,
      name: routineName,
      description: "E2E routine-source chip fixture",
      enabled: true,
      trigger: { kind: "one_time", at: futureAt },
      runTemplate: {
        prompt: "E2E routine source chip probe body.",
        target: { kind: "agent_definition", agentDefinitionId: "builtin:sde" },
        resources: {},
        workspace: { kind: "none" },
        mode: "ask",
        name: routineName,
      },
      outputPolicy: {
        mode: "create_work_item",
        concurrencyPolicy: "always_create",
        catchUpPolicy: "skip_missed",
        maxCatchUpRuns: 1,
        idempotencyScope: "routine_fire",
        createWorkItemStatus: "planned",
        // Standalone item (no project slug) — auto_start does not apply,
        // fire succeeds immediately with workItemId set.
        autoStart: false,
        createWorkItemTitle: `E2E routine source chip ${RUN_ID}`,
        createWorkItemBody: "Created by routine fire for chip probe.",
      },
      createdAt: now,
      updatedAt: now,
    };

    let createdShortId = null;
    try {
      unwrap(
        await invokeE2E("upsertRoutine", routine),
        "upsertRoutine(routine source chip)"
      );
      const fireResult = unwrap(
        await invokeE2E("fireRoutine", routine.id),
        "fireRoutine(routine source chip)"
      );
      createdShortId = fireResult.result?.fire?.workItemId ?? null;
      if (!createdShortId) {
        throw new Error(
          `fireRoutine did not create a work item: ${JSON.stringify(fireResult.result)}`
        );
      }

      // Frontend contract: routineSource survived the adapter mapping.
      // Wire shape: snake_case frontmatter key, camelCase inner fields
      // (Rust WorkItemRoutineSource is rename_all = "camelCase").
      const item = unwrap(
        await invokeE2E("readStandaloneWorkItem", createdShortId),
        "readStandaloneWorkItem(routine source chip)"
      );
      const routineSource = item.item?.frontmatter?.routine_source;
      if (!routineSource || routineSource.routineId !== routine.id) {
        throw new Error(
          `Created work item lacks routine_source: ${JSON.stringify(routineSource)}`
        );
      }

      // Rendered UI contract: chip visible in the detail view.
      unwrap(
        await invokeE2E("openWorkspaceWorkItemsTab"),
        "openWorkspaceWorkItemsTab(routine source chip)"
      );
      const rowSelector = `[data-testid="work-item-row-${createdShortId}"]`;
      await browser.waitUntil(
        async () => (await clickSelector(rowSelector)) === "clicked",
        {
          timeout: MOUNT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "Routine-created work item row never became clickable",
        }
      );

      let chipState = null;
      await browser.waitUntil(
        async () => {
          chipState = await execJS(`
            const chip = document.querySelector('[data-testid="work-item-routine-source-chip"]');
            return {
              hasChip: Boolean(chip),
              text: chip ? chip.textContent : null,
            };
          `);
          return (
            chipState.hasChip && (chipState.text ?? "").includes(routineName)
          );
        },
        {
          timeout: MOUNT_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: `Routine source chip did not render with routine name: ${JSON.stringify(chipState)}`,
        }
      );
    } finally {
      // Standalone created item has no E2E delete helper; RUN_ID isolation
      // keeps reruns clean. The routine itself is removed.
      await invokeE2E("deleteRoutine", routine.id);
    }
  });
});
