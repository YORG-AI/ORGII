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
  vi,
} from "vitest";

import TurnCollapsePinBar from "./TurnCollapsePinBar";

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => new Map(),
  useSetAtom: () => vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join("-")}` : key,
  }),
}));

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({ canReplay: false, replayEventById: vi.fn() }),
}));

describe("TurnCollapsePinBar text selection", () => {
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

  it("does not make the duration and time range selectable", () => {
    act(() => {
      root.render(
        createElement(TurnCollapsePinBar, {
          turnId: "turn-1",
          durationMs: 42_000,
          startMs: new Date("2026-08-28T14:27:00Z").getTime(),
          endMs: new Date("2026-08-28T14:27:42Z").getTime(),
          defaultCollapsed: true,
          turnCollapseInteractionAtRef: { current: 0 },
        })
      );
    });

    const timing = container.querySelector<HTMLSpanElement>("button > span");
    expect(timing?.classList.contains("select-none")).toBe(true);
    expect(timing?.querySelector(".select-text")).toBeNull();
  });
});
