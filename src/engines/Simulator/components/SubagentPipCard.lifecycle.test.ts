// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { SubagentSession } from "../hooks/useSubagentSessions";
import { SubagentPipCard } from "./SubagentPipCard";

vi.mock("../hooks/useMultiSessionSimulatorEvents", () => ({
  // Support the independent history-lifecycle PR while this selection regression
  // stays concerned only with roster/selection behavior.
  useMultiSessionSimulatorEvents: () => {
    const events = new Map();
    return Object.assign(events, {
      eventsMap: events,
      loadState: () => ({ status: "ready", retry: () => {} }),
    });
  },
}));
vi.mock("./GridCell/IndependentGridCell", () => ({
  IndependentGridCell: ({
    threadId,
    onExpand,
    isExpanded,
  }: {
    threadId: string;
    onExpand: () => void;
    isExpanded: boolean;
  }) =>
    createElement(
      "button",
      {
        "data-cell": threadId,
        "data-expanded": String(isExpanded),
        onClick: onExpand,
      },
      threadId
    ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock(
  "@src/modules/shared/components/FileHeader/BreadcrumbFileHeader",
  () => ({ default: () => null })
);
vi.mock("@src/engines/ChatPanel/blocks/primitives", () => ({
  EVENT_LOADING_SHIMMER_TEXT_CLASSES: "",
}));
function sessions(ids: string[]): SubagentSession[] {
  return ids.map((id) => ({
    key: id,
    sessionId: id,
    name: id,
    description: "",
    sessionType: "agent",
    status: "running",
    isBackground: true,
    startedAtMs: 0,
    endedAtMs: null,
    isTerminal: false,
  }));
}
it("keeps the expanded child through roster updates and resets on a parent key change", () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (ids: string[], parent = "parent-a") =>
    act(() =>
      root.render(
        createElement(SubagentPipCard, {
          key: parent,
          activeSessions: sessions(ids),
          mainContent: null,
        })
      )
    );
  try {
    render(["a", "b", "c"]);
    act(() =>
      host.querySelector<HTMLButtonElement>('[data-cell="b"]')?.click()
    );
    expect(
      host.querySelector('[data-cell="b"]')?.getAttribute("data-expanded")
    ).toBe("true");
    render(["new", "a", "c", "b"]);
    expect(host.querySelectorAll("[data-cell]")).toHaveLength(1);
    expect(
      host.querySelector('[data-cell="b"]')?.getAttribute("data-expanded")
    ).toBe("true");
    render(["new", "a", "c", "b"], "parent-b");
    expect(host.querySelectorAll("[data-cell]")).toHaveLength(2);
    expect(host.querySelector('[data-expanded="true"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    delete env.IS_REACT_ACT_ENVIRONMENT;
    vi.unstubAllGlobals();
  }
});
