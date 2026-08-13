import { describe, expect, it } from "vitest";

import {
  ROUTINE_TARGET_KIND,
  createRoutineDefinition,
  createRoutineDraft,
} from "./routineDraft";

describe("Routine timezone draft", () => {
  it("uses the configured timezone for new schedules", () => {
    const draft = createRoutineDraft(undefined, "America/Vancouver");
    expect(draft.timezone).toBe("America/Vancouver");
  });

  it("serializes UTC and IANA timezones on cron triggers", () => {
    const draft = createRoutineDraft(undefined, "utc");
    draft.name = "Daily check";
    draft.prompt = "Check the project";
    draft.triggerKind = "CRON";
    draft.cron = "0 9 * * *";
    draft.target = {
      kind: ROUTINE_TARGET_KIND.AGENT_DEFINITION,
      agentDefinitionId: "builtin:sde",
    };

    const utcDefinition = createRoutineDefinition(
      draft,
      undefined,
      "2026-08-08T00:00:00.000Z"
    );
    expect(utcDefinition.trigger).toEqual({
      kind: "cron",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    draft.timezone = "Asia/Shanghai";
    const shanghaiDefinition = createRoutineDefinition(
      draft,
      undefined,
      "2026-08-08T00:00:00.000Z"
    );
    expect(shanghaiDefinition.trigger).toEqual({
      kind: "cron",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
    });
  });
});
