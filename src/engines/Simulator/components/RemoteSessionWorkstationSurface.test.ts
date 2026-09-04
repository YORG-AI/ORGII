/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import { RemoteSessionWorkstationSurface } from "./RemoteSessionWorkstationSurface";

vi.mock("../ActivitySimulator", () => ({
  default: () => React.createElement("div", { "data-agent-replay": true }),
}));

vi.mock("./RemoteSessionWorkspaceSurface", () => ({
  RemoteSessionWorkspaceSurface: () =>
    React.createElement("div", { "data-session-workspace": true }),
}));

vi.mock("@src/modules/WorkStation/shared/StationModePill", () => ({
  StationModePillView: ({
    stationMode,
    onStationModeChange,
  }: {
    stationMode: "my-station" | "agent-station";
    onStationModeChange: (mode: "my-station" | "agent-station") => void;
  }) =>
    React.createElement(
      "div",
      null,
      React.createElement(
        "button",
        {
          "data-switch-station": "my-station",
          "aria-pressed": stationMode === "my-station",
          onClick: () => onStationModeChange("my-station"),
        },
        "My Station"
      ),
      React.createElement(
        "button",
        {
          "data-switch-station": "agent-station",
          "aria-pressed": stationMode === "agent-station",
          onClick: () => onStationModeChange("agent-station"),
        },
        "Agent Station"
      )
    ),
}));

describe("RemoteSessionWorkstationSurface", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  it("defaults to My Station and switches to Agent Station on demand", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(
      React.createElement(RemoteSessionWorkstationSurface, {
        sessionId: "session-1",
        events: [],
        loadStatus: "loaded",
        loadError: null,
      })
    );

    const agentPanel = root.container.querySelector(
      '[data-remote-station-panel="agent-station"]'
    );
    const workspacePanel = root.container.querySelector(
      '[data-remote-station-panel="my-station"]'
    );
    expect(agentPanel).toBeNull();
    expect(workspacePanel).not.toBeNull();
    expect(root.container.querySelector("[data-agent-replay]")).toBeNull();
    expect(
      root.container.querySelector("[data-session-workspace]")
    ).not.toBeNull();

    const agentStationButton = root.container.querySelector<HTMLButtonElement>(
      '[data-switch-station="agent-station"]'
    );
    await dispatch(() => agentStationButton?.click());

    expect(
      root.container.querySelector(
        '[data-remote-station-panel="agent-station"]'
      )
    ).not.toBeNull();
    expect(
      root.container.querySelector('[data-remote-station-panel="my-station"]')
    ).toBeNull();
    expect(root.container.querySelector("[data-agent-replay]")).not.toBeNull();
    expect(root.container.querySelector("[data-session-workspace]")).toBeNull();

    const myStationButton = root.container.querySelector<HTMLButtonElement>(
      '[data-switch-station="my-station"]'
    );
    await dispatch(() => myStationButton?.click());

    expect(
      root.container.querySelector(
        '[data-remote-station-panel="agent-station"]'
      )
    ).toBeNull();
    expect(
      root.container.querySelector('[data-remote-station-panel="my-station"]')
    ).not.toBeNull();
  });

  it("returns to My Station when the remote session changes", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    const renderSession = (sessionId: string) =>
      React.createElement(RemoteSessionWorkstationSurface, {
        sessionId,
        events: [],
        loadStatus: "loaded" as const,
        loadError: null,
      });

    await root.render(renderSession("session-1"));
    const myStationButton = root.container.querySelector<HTMLButtonElement>(
      '[data-switch-station="my-station"]'
    );
    await dispatch(() => myStationButton?.click());
    await root.render(renderSession("session-2"));

    expect(
      root.container.querySelector('[data-remote-station-panel="my-station"]')
    ).not.toBeNull();
    expect(
      root.container
        .querySelector<HTMLButtonElement>('[data-switch-station="my-station"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
  });
});
