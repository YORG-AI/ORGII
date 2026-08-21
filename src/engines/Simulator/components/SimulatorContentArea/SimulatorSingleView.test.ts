/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import { ReplayControlHostContext } from "../../context/ReplayControlHostContext";
import { AppType } from "../../types/appTypes";
import { SimulatorSingleView } from "./SimulatorSingleView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/engines/SessionCore/hooks/session", () => ({
  useSessionId: () => ({ sessionId: "session-1" }),
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  NoTabsPlaceholder: () => React.createElement("div"),
}));

vi.mock("../FloatingReplayContainer", () => ({
  default: () => React.createElement("div", { "data-floating-replay": true }),
}));

describe("SimulatorSingleView replay host ownership", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  const content = React.createElement("div", { "data-content": true });

  it("keeps the desktop floating replay control by default", async () => {
    const root = createSmokeRoot();
    roots.push(root);

    await root.render(
      React.createElement(SimulatorSingleView, {
        isBootingEvent: false,
        mainContentAppType: AppType.CODE_EDITOR,
        displayContent: content,
      })
    );

    expect(
      root.container.querySelector("[data-floating-replay]")
    ).not.toBeNull();
  });

  it("hides the nested control when the Web host owns replay", async () => {
    const root = createSmokeRoot();
    roots.push(root);

    await root.render(
      React.createElement(
        ReplayControlHostContext.Provider,
        { value: true },
        React.createElement(SimulatorSingleView, {
          isBootingEvent: false,
          mainContentAppType: AppType.CODE_EDITOR,
          displayContent: content,
        })
      )
    );

    expect(root.container.querySelector("[data-floating-replay]")).toBeNull();
  });
});
