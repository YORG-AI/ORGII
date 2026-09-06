import { describe, expect, it } from "vitest";

import {
  ROUTINE_TARGET_KIND,
  createActivationDraft,
  createRoutineDefinition,
  createRoutineDraft,
  isRoutineDraftValid,
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

describe("activation drafts", () => {
  it("builds the full activation list with the primary trigger first", () => {
    const draft = createRoutineDraft(undefined, "utc");
    draft.name = "Nightly";
    draft.prompt = "Run the nightly sweep";
    draft.triggerKind = "CRON";
    draft.cron = "0 9 * * *";
    draft.target = {
      kind: ROUTINE_TARGET_KIND.AGENT_DEFINITION,
      agentDefinitionId: "builtin:sde",
    };
    const webhook = createActivationDraft("provider_event");
    webhook.provider = "github";
    webhook.eventKind = "pull_request";
    draft.extraActivations = [webhook];

    const definition = createRoutineDefinition(
      draft,
      undefined,
      "2026-08-20T00:00:00.000Z"
    );
    expect(definition.activations).toEqual([
      { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      { type: "provider_event", provider: "github", eventKind: "pull_request" },
    ]);
  });

  it("always emits the primary activation and round-trips extras back", () => {
    const draft = createRoutineDraft(undefined, "utc");
    draft.triggerKind = "CRON";
    draft.cron = "0 9 * * *";
    draft.name = "Nightly";
    draft.prompt = "p";
    draft.target = {
      kind: ROUTINE_TARGET_KIND.AGENT_DEFINITION,
      agentDefinitionId: "builtin:sde",
    };
    const plain = createRoutineDefinition(
      draft,
      undefined,
      "2026-08-20T00:00:00.000Z"
    );
    expect(plain.activations).toEqual([
      { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    ]);

    const reloaded = createRoutineDraft(
      {
        ...plain,
        activations: [
          { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
          { type: "manual" },
          {
            type: "provider_event",
            provider: "github",
            eventKind: "pull_request",
          },
        ],
      },
      "utc"
    );
    expect(reloaded.extraActivations).toHaveLength(2);
    expect(reloaded.extraActivations[0].type).toBe("manual");
    expect(reloaded.extraActivations[1].provider).toBe("github");
  });
});

describe("activations as the single source of the trigger", () => {
  function baseDraft() {
    const draft = createRoutineDraft(undefined, "utc");
    draft.name = "Webhook";
    draft.prompt = "p";
    draft.target = {
      kind: ROUTINE_TARGET_KIND.AGENT_DEFINITION,
      agentDefinitionId: "builtin:sde",
    };
    return draft;
  }

  it("omits the derived trigger when no activation is schedulable", () => {
    const draft = baseDraft();
    draft.triggerKind = "PROVIDER_EVENT";
    draft.provider = "github";
    draft.eventKind = "pull_request";
    expect(isRoutineDraftValid(draft)).toBe(true);

    const definition = createRoutineDefinition(
      draft,
      undefined,
      "2026-08-23T00:00:00.000Z"
    );
    expect(definition.trigger).toBeUndefined();
    expect(definition.activations).toEqual([
      { type: "provider_event", provider: "github", eventKind: "pull_request" },
    ]);
  });

  it("derives the trigger from the first schedulable activation", () => {
    const draft = baseDraft();
    draft.triggerKind = "MANUAL";
    const nightly = createActivationDraft("schedule");
    nightly.cron = "30 8 * * 2";
    nightly.timezone = "Asia/Tokyo";
    draft.extraActivations = [nightly];

    const definition = createRoutineDefinition(
      draft,
      undefined,
      "2026-08-23T00:00:00.000Z"
    );
    expect(definition.activations?.[0]).toEqual({ type: "manual" });
    expect(definition.trigger).toEqual({
      kind: "cron",
      cron: "30 8 * * 2",
      timezone: "Asia/Tokyo",
    });
  });

  it("rejects a provider-event primary without provider and event", () => {
    const draft = baseDraft();
    draft.triggerKind = "PROVIDER_EVENT";
    draft.provider = "github";
    expect(isRoutineDraftValid(draft)).toBe(false);
    draft.triggerKind = "MANUAL";
    expect(isRoutineDraftValid(draft)).toBe(true);
  });

  it("reloads the primary kind from activations before the legacy trigger", () => {
    const draft = baseDraft();
    draft.triggerKind = "MANUAL";
    const definition = createRoutineDefinition(
      draft,
      undefined,
      "2026-08-23T00:00:00.000Z"
    );
    const reloaded = createRoutineDraft(
      {
        ...definition,
        trigger: { kind: "cron", cron: "0 0 * * *", timezone: "UTC" },
        activations: [
          { type: "provider_event", provider: "gitlab", eventKind: "push" },
        ],
      },
      "utc"
    );
    expect(reloaded.triggerKind).toBe("PROVIDER_EVENT");
    expect(reloaded.provider).toBe("gitlab");
    expect(reloaded.eventKind).toBe("push");

    const legacy = createRoutineDraft(
      {
        ...definition,
        trigger: { kind: "one_time", at: "2026-09-01T09:00:00.000Z" },
        activations: [],
      },
      "utc"
    );
    expect(legacy.triggerKind).toBe("ONE_TIME");
    expect(legacy.at).toBe("2026-09-01T09:00");
  });
});
