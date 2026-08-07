import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import type { AgentRunnerSettingsByOrg } from "./agentTaskRunnerSettingsAtom";
import {
  AGENT_TASK_RUNNER_SETTINGS_STORAGE_KEY,
  __AGENT_RUNNER_SETTINGS_STORAGE,
  agentTaskRunnerSettingsAtom,
  resolveAgentRunnerSettings,
  withAgentRunnerAutoRun,
  withAgentRunnerSetting,
} from "./agentTaskRunnerSettingsAtom";

const ORG = "corg-1";
const KEY = AGENT_TASK_RUNNER_SETTINGS_STORAGE_KEY;
const storage = __AGENT_RUNNER_SETTINGS_STORAGE;

describe("agentTaskRunnerSettings persistence (zod roundtrip)", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
  });

  it("the atom writes through to the storage key (serialized JSON)", () => {
    const written: AgentRunnerSettingsByOrg = {
      [ORG]: { accountId: "acc-1", model: "claude-opus-4", mode: "plan" },
    };
    createStore().set(agentTaskRunnerSettingsAtom, written);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(written);
  });

  it("roundtrips a per-org record through the zod storage", () => {
    const written: AgentRunnerSettingsByOrg = {
      [ORG]: { accountId: "acc-1", model: "claude-opus-4", mode: "plan" },
      "corg-2": { model: "gpt-5" },
    };
    storage.setItem(KEY, written);
    expect(storage.getItem(KEY, {})).toEqual(written);
  });

  it("accepts partial records (every field optional)", () => {
    storage.setItem(KEY, { [ORG]: {} });
    expect(storage.getItem(KEY, {})).toEqual({ [ORG]: {} });
  });

  it("degrades schema-mismatched storage to the initial value", () => {
    localStorage.setItem(KEY, JSON.stringify({ [ORG]: { mode: 42 } }));
    expect(storage.getItem(KEY, {})).toEqual({});
  });

  it("degrades non-JSON garbage to the initial value", () => {
    localStorage.setItem(KEY, "not-json{");
    expect(storage.getItem(KEY, {})).toEqual({});
  });

  it("returns the initial value when nothing is stored", () => {
    expect(storage.getItem(KEY, {})).toEqual({});
  });
});

describe("resolveAgentRunnerSettings (READ-side defaults)", () => {
  it("resolves an unknown org to mode 'build', auto-run OFF, NO account/model keys", () => {
    const resolved = resolveAgentRunnerSettings({}, ORG);
    expect(resolved).toEqual({ mode: "build", autoRunEnabled: false });
    // Key-presence semantics: agentOptions spread must not carry the keys.
    expect("accountId" in resolved).toBe(false);
    expect("model" in resolved).toBe(false);
  });

  it("defaults ONLY the missing fields", () => {
    expect(
      resolveAgentRunnerSettings({ [ORG]: { accountId: "acc-1" } }, ORG)
    ).toEqual({ accountId: "acc-1", mode: "build", autoRunEnabled: false });
    expect(
      resolveAgentRunnerSettings({ [ORG]: { model: "claude-opus-4" } }, ORG)
    ).toEqual({ model: "claude-opus-4", mode: "build", autoRunEnabled: false });
  });

  it("an explicit mode wins over the 'build' default", () => {
    expect(resolveAgentRunnerSettings({ [ORG]: { mode: "ask" } }, ORG)).toEqual(
      { mode: "ask", autoRunEnabled: false }
    );
  });

  it("treats empty-string fields as absent (cleared selects)", () => {
    expect(
      resolveAgentRunnerSettings(
        { [ORG]: { accountId: "", model: "", mode: "" } },
        ORG
      )
    ).toEqual({ mode: "build", autoRunEnabled: false });
  });

  it("reflects the stored auto-run opt-in, defaulting OFF when absent", () => {
    expect(
      resolveAgentRunnerSettings({ [ORG]: { autoRunEnabled: true } }, ORG)
        .autoRunEnabled
    ).toBe(true);
    expect(resolveAgentRunnerSettings({ [ORG]: {} }, ORG).autoRunEnabled).toBe(
      false
    );
  });
});

describe("withAgentRunnerAutoRun (owner opt-in, default OFF)", () => {
  it("sets and clears the opt-in, never storing false", () => {
    const on = withAgentRunnerAutoRun({}, ORG, true);
    expect(on).toEqual({ [ORG]: { autoRunEnabled: true } });
    // Turning it off drops the field (and the now-empty org record).
    expect(withAgentRunnerAutoRun(on, ORG, false)).toEqual({});
  });

  it("no-ops (same reference) when the value does not change", () => {
    const on = withAgentRunnerAutoRun({}, ORG, true);
    expect(withAgentRunnerAutoRun(on, ORG, true)).toBe(on);
    // Disabling when never enabled is also a no-op.
    expect(withAgentRunnerAutoRun({}, ORG, false)).toEqual({});
  });

  it("preserves the other picker fields when toggling", () => {
    const seeded = withAgentRunnerSetting({}, ORG, "model", "m-1");
    const on = withAgentRunnerAutoRun(seeded, ORG, true);
    expect(on).toEqual({ [ORG]: { model: "m-1", autoRunEnabled: true } });
    expect(withAgentRunnerAutoRun(on, ORG, false)).toEqual({
      [ORG]: { model: "m-1" },
    });
  });
});

describe("withAgentRunnerSetting (immutable field updates)", () => {
  it("creates the org record on demand and updates one field", () => {
    const a = withAgentRunnerSetting({}, ORG, "accountId", "acc-1");
    expect(a).toEqual({ [ORG]: { accountId: "acc-1" } });
    const b = withAgentRunnerSetting(a, ORG, "mode", "plan");
    expect(b).toEqual({ [ORG]: { accountId: "acc-1", mode: "plan" } });
  });

  it("no-ops (same reference) when the value does not change", () => {
    const a = withAgentRunnerSetting({}, ORG, "model", "m-1");
    expect(withAgentRunnerSetting(a, ORG, "model", "m-1")).toBe(a);
    // Clearing a field that was never set is also a no-op.
    expect(withAgentRunnerSetting(a, ORG, "accountId", undefined)).toBe(a);
    expect(withAgentRunnerSetting({}, ORG, "model", "")).toEqual({});
  });

  it("clears a field via undefined OR empty string", () => {
    const seeded = withAgentRunnerSetting(
      withAgentRunnerSetting({}, ORG, "accountId", "acc-1"),
      ORG,
      "model",
      "m-1"
    );
    expect(withAgentRunnerSetting(seeded, ORG, "model", undefined)).toEqual({
      [ORG]: { accountId: "acc-1" },
    });
    expect(withAgentRunnerSetting(seeded, ORG, "model", "")).toEqual({
      [ORG]: { accountId: "acc-1" },
    });
  });

  it("drops the org record entirely when its last field is cleared", () => {
    const other: AgentRunnerSettingsByOrg = { "corg-2": { mode: "ask" } };
    const seeded = withAgentRunnerSetting(
      { ...other },
      ORG,
      "accountId",
      "acc-1"
    );
    const cleared = withAgentRunnerSetting(seeded, ORG, "accountId", undefined);
    expect(cleared).toEqual(other);
    expect(ORG in cleared).toBe(false);
  });

  it("write→resolve composes: cleared model falls back, mode stays concrete", () => {
    let byOrg: AgentRunnerSettingsByOrg = {};
    byOrg = withAgentRunnerSetting(byOrg, ORG, "model", "m-1");
    byOrg = withAgentRunnerSetting(byOrg, ORG, "mode", "ask");
    byOrg = withAgentRunnerSetting(byOrg, ORG, "model", undefined);
    expect(resolveAgentRunnerSettings(byOrg, ORG)).toEqual({
      mode: "ask",
      autoRunEnabled: false,
    });
    byOrg = withAgentRunnerSetting(byOrg, ORG, "mode", undefined);
    expect(resolveAgentRunnerSettings(byOrg, ORG)).toEqual({
      mode: "build",
      autoRunEnabled: false,
    });
  });
});
