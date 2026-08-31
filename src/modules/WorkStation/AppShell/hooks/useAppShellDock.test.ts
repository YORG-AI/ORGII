import { describe, expect, it } from "vitest";

import { advanceAppShellDockSnapshot } from "./useAppShellDock";

describe("advanceAppShellDockSnapshot", () => {
  it("accumulates each visited host without replacing the bounded set", () => {
    const code = {
      activeHost: "code",
      hasRealTabs: true,
      visitedModes: new Set(["code"]),
    };
    const browser = advanceAppShellDockSnapshot(code, "browser", true);
    const project = advanceAppShellDockSnapshot(browser, "project", true);

    expect([...project.visitedModes]).toEqual(["code", "browser", "project"]);
    expect(advanceAppShellDockSnapshot(project, "project", true)).toBe(project);
  });

  it("releases every retained host when the real-tab pool empties", () => {
    const cleared = advanceAppShellDockSnapshot(
      {
        activeHost: "project",
        hasRealTabs: true,
        visitedModes: new Set(["code", "project"]),
      },
      "code",
      false
    );

    expect(cleared.visitedModes.size).toBe(0);
  });
});
