// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  type SetupWalkthroughProgress,
  createDefaultSetupWalkthroughProgress,
} from "@src/config/settingsSchema/setupWalkthroughProgress";

import { useSyncedSetupWalkthroughProgress } from "../useSyncedSetupWalkthroughProgress";

function completedPersonalProgress(): SetupWalkthroughProgress {
  return {
    ...createDefaultSetupWalkthroughProgress(),
    goal: "personal",
    currentStepId: "work-model",
    completedStepIds: ["goal", "tools", "basics", "tutorial"],
  };
}

function Harness({ stored }: { stored: SetupWalkthroughProgress }) {
  const { progress, replaceProgress } =
    useSyncedSetupWalkthroughProgress(stored);

  return createElement(
    "button",
    {
      "data-goal": progress.goal ?? "unselected",
      "data-step": progress.currentStepId,
      onClick: () =>
        replaceProgress({
          ...progress,
          goal: "team_activity",
        }),
      type: "button",
    },
    "Select team"
  );
}

describe("useSyncedSetupWalkthroughProgress", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("returns a mounted walkthrough to Goal when the persisted owner resets", async () => {
    const completed = completedPersonalProgress();

    await act(async () => {
      root.render(createElement(Harness, { stored: completed }));
    });

    expect(container.querySelector("button")?.dataset).toMatchObject({
      goal: "personal",
      step: "work-model",
    });

    await act(async () => {
      root.render(
        createElement(Harness, {
          stored: createDefaultSetupWalkthroughProgress(),
        })
      );
    });

    expect(container.querySelector("button")?.dataset).toMatchObject({
      goal: "unselected",
      step: "goal",
    });
  });

  it("keeps a local draft when an unrelated parent render retains the same persisted value", async () => {
    const stored = createDefaultSetupWalkthroughProgress();

    await act(async () => {
      root.render(createElement(Harness, { stored }));
    });

    act(() => container.querySelector("button")?.click());

    await act(async () => {
      root.render(createElement(Harness, { stored }));
    });

    expect(container.querySelector("button")?.dataset.goal).toBe(
      "team_activity"
    );
  });
});
