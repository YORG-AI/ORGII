// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import JourneyStationSidebar from "./JourneyStationSidebar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

vi.mock("@src/modules/ProjectManager/ProjectJourney", () => ({
  loadProjectTreeBundle: vi.fn().mockResolvedValue({
    projects: [],
    tree: {
      id: "workspace:root",
      kind: "workspace",
      title: "Workspace",
      children: [],
    },
    workItemsByProject: {},
    standaloneWorkItems: [],
    usedDemo: false,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("JourneyStationSidebar unlinked sessions contract", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("always renders the unlinked sessions section and its empty state", async () => {
    await act(async () => {
      root.render(<JourneyStationSidebar />);
    });

    const unlinkedSection = container.querySelector(
      'section[aria-label="未关联项目的会话"]'
    );
    expect(unlinkedSection).not.toBeNull();
    expect(unlinkedSection?.textContent).toContain("暂无会话");
  });
});
