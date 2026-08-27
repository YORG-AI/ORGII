import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import { getWorkStationStationTitleCenter } from "../dockTitleCenter";

vi.mock("../config", () => ({
  getAppById: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  Chromium: "ChromiumIcon",
  Code: "CodeIcon",
  ListTodo: "ListTodoIcon",
}));

const navigationT = ((key: string) => key) as TFunction<"navigation">;

describe("getWorkStationStationTitleCenter", () => {
  it("maps app modes to stable icon tokens and navigation keys", () => {
    expect(getWorkStationStationTitleCenter("code", navigationT)).toEqual({
      icon: "CodeIcon",
      label: "labels.codeEditor",
    });
    expect(getWorkStationStationTitleCenter("browser", navigationT)).toEqual({
      icon: "ChromiumIcon",
      label: "labels.browser",
    });
    expect(getWorkStationStationTitleCenter("project", navigationT)).toEqual({
      icon: "ListTodoIcon",
      label: "labels.projectManager",
    });
  });

  it("falls back to code editor for unknown modes", () => {
    expect(
      getWorkStationStationTitleCenter("unknown-mode", navigationT)
    ).toEqual({
      icon: "CodeIcon",
      label: "labels.codeEditor",
    });
  });
});
