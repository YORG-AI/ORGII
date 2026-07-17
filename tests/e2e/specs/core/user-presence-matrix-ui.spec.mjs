/* global describe, before, after, it, browser */
/**
 * User Presence matrix — UI surface contract.
 *
 * Covers the data-driven presence-mode redesign:
 *   1. Settings persistence for the three per-presence policy objects
 *      (question auto-skip / plan auto-approve / goal max-turns).
 *   2. My Role page renders the policy editor rows for built-in modes.
 *   3. Custom mode is a pure data row: seeding a role with policy fields
 *      makes it selectable and the active presence pill renders it.
 *
 * Runtime matrix behavior (backend auto-resolve deadlines, goal loop
 * judge/budget/preemption, presence-switch re-arming) is pinned by Rust
 * unit tests in `presence_policy.rs`, `presence_state.rs`, `goal_loop.rs`
 * — those paths run without UI by design (backend-authoritative).
 */
import {
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

const WAIT_TIMEOUT_MS = 30_000;

async function readSettings() {
  return unwrap(await invokeE2E("readSettings"), "read settings").settings;
}

async function writeSettingsPartial(partial) {
  unwrap(
    await invokeE2E("writeSettingsPartial", partial),
    "write settings partial"
  );
}

async function waitForScript(predicateScript, label, args = []) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await browser.executeScript(predicateScript, args);
      return state === true || state?.ok === true;
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label}: ${JSON.stringify(state, null, 2)}`,
    }
  );
}

describe("User presence mode policy UI", () => {
  let originalQuestion = null;
  let originalPlan = null;
  let originalGoal = null;
  let originalPresence = { mode: "online" };
  let originalCustomRoles = [];

  before(async () => {
    await waitForApp();
    await browser.executeScript(
      `
        localStorage.setItem("orgii:auth_skipped", "1");
        return true;
      `,
      []
    );
    const settings = await readSettings();
    originalQuestion = settings["agent.sde.questionAutoSkipTimeoutByPresence"];
    originalPlan = settings["agent.sde.planAutoApproveTimeoutByPresence"];
    originalGoal = settings["agent.sde.goalMaxTurnsByPresence"];
    const storedPresence = await browser.executeScript(
      `return {
        presence: JSON.parse(localStorage.getItem("orgii:userPresence") || '{"mode":"online"}'),
        roles: JSON.parse(localStorage.getItem("orgii:userCustomRoles") || '[]'),
      };`,
      []
    );
    // Also cleans residue from an interrupted prior run without touching any
    // real custom role: the E2E id is reserved by this spec.
    originalCustomRoles = storedPresence.roles.filter(
      (role) => role.id !== "e2e-angry"
    );
    originalPresence =
      storedPresence.presence?.mode === "role:e2e-angry"
        ? { mode: "online" }
        : storedPresence.presence;
    unwrap(
      await invokeE2E("seedUserPresence", {
        roles: originalCustomRoles,
        presence: originalPresence,
      }),
      "sanitize custom presence fixture"
    );
  });

  after(async () => {
    // Restore original values so the run leaves no policy drift behind.
    const restore = {};
    if (originalQuestion)
      restore["agent.sde.questionAutoSkipTimeoutByPresence"] = originalQuestion;
    if (originalPlan)
      restore["agent.sde.planAutoApproveTimeoutByPresence"] = originalPlan;
    if (originalGoal)
      restore["agent.sde.goalMaxTurnsByPresence"] = originalGoal;
    if (Object.keys(restore).length > 0) {
      await writeSettingsPartial(restore);
    }
    await invokeE2E("seedUserPresence", {
      roles: originalCustomRoles,
      presence: originalPresence,
    });
    await browser.executeScript(
      `
        localStorage.removeItem("orgii:e2eAngryRoleSeeded");
        return true;
      `,
      []
    );
  });

  it("persists the three per-presence policy objects through settings", async () => {
    await writeSettingsPartial({
      "agent.sde.questionAutoSkipTimeoutByPresence": {
        online: 0,
        invisible: 25,
        away: 150,
      },
      "agent.sde.planAutoApproveTimeoutByPresence": {
        online: 0,
        invisible: 90,
        away: 0,
      },
      "agent.sde.goalMaxTurnsByPresence": {
        online: 0,
        invisible: 12,
        away: 0,
      },
    });

    let last = null;
    await browser.waitUntil(
      async () => {
        last = await readSettings();
        return (
          last["agent.sde.questionAutoSkipTimeoutByPresence"]?.invisible ===
            25 &&
          last["agent.sde.planAutoApproveTimeoutByPresence"]?.invisible ===
            90 &&
          last["agent.sde.goalMaxTurnsByPresence"]?.invisible === 12
        );
      },
      {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: `presence policy settings did not persist. Last=${JSON.stringify(
          {
            q: last?.["agent.sde.questionAutoSkipTimeoutByPresence"],
            p: last?.["agent.sde.planAutoApproveTimeoutByPresence"],
            g: last?.["agent.sde.goalMaxTurnsByPresence"],
          }
        )}`,
      }
    );
  });

  it("renders the policy editor rows on the My Role settings page", async () => {
    await browser.executeScript(
      `
        window.location.hash = "";
        window.history.pushState({}, "", "/orgii/app/settings/my-role");
        window.dispatchEvent(new PopStateEvent("popstate"));
        return true;
      `,
      []
    );

    await waitForScript(
      `
        const text = document.body.innerText;
        const hasGuidance = text.includes("My Role") || text.includes("我的角色") || text.includes("My Roles");
        // Policy editor rows (label fallbacks are en defaults).
        const hasStance = text.includes("Behavior stance") || text.includes("stance");
        const hasGoal = text.includes("Goal continuation budget") || text.includes("goal");
        const hasPlan = text.includes("Plan auto-approve") || text.includes("plan auto");
        return {
          ok: hasGuidance && hasStance && hasGoal && hasPlan,
          hasGuidance, hasStance, hasGoal, hasPlan,
          preview: text.slice(0, 1200),
        };
      `,
      "My Role policy editor rows did not render"
    );
  });

  it("treats a custom mode as a pure data row (seed → selectable → active)", async () => {
    // Seed an "Angry" role with explicit autonomous policy directly into
    // the role store (data path — no special-case code may be needed).
    // jotai's atomWithStorage subscribes to `storage` events, so a
    // manually-dispatched StorageEvent updates the live atoms without a
    // reload (reload kills the tauri-wd session).
    const roles = [...originalCustomRoles];
    roles.push({
      id: "e2e-angry",
      label: "E2E Angry",
      iconId: "flame",
      guidance: "Be direct and terse.",
      createdAtMs: Date.now(),
      stance: "autonomous",
      questionAutoResolveSecs: 15,
      planAutoApproveSecs: 0,
      goalMaxTurns: 2,
    });
    unwrap(
      await invokeE2E("seedUserPresence", {
        roles,
        presence: { mode: "role:e2e-angry" },
      }),
      "seed custom presence role"
    );

    // The selected custom row proves the role and active mode resolved end to
    // end from pure data through the production My Role UI. The role name is
    // an input value (not body text), so assert the actual rendered control
    // and the selected badge in its containing role card.
    await waitForScript(
      `
        const input = Array.from(document.querySelectorAll('input')).find(
          (candidate) => candidate.value === 'E2E Angry'
        );
        const row = input?.closest('div.flex.flex-col.gap-3');
        return {
          ok: !!input && !!row?.querySelector('.bg-primary-1'),
          text: row?.textContent ?? null,
          hasActiveBadge: !!row?.querySelector('.bg-primary-1'),
        };
      `,
      "custom presence mode did not render as the active My Role row"
    );

    // Restore Online and remove the seeded role.
    unwrap(
      await invokeE2E("seedUserPresence", {
        roles: originalCustomRoles,
        presence: originalPresence,
      }),
      "restore custom presence role"
    );

    // Negative sweep: the seeded label must disappear after restore.
    await waitForScript(
      `
        return {
          ok: !Array.from(document.querySelectorAll('input')).some(
            (input) => input.value === 'E2E Angry'
          ),
        };
      `,
      "seeded custom role label did not clear after restore"
    );
  });
});
