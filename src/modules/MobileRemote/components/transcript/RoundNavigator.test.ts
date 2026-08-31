// @vitest-environment jsdom
import React, { act } from "react";
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

import { RoundNavigator } from "./RoundNavigator";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { current?: number; total?: number }) =>
      ({
        "rounds.navigationLabel": "会话轮次",
        "rounds.label": `第 ${values?.current} / ${values?.total} 轮`,
        "rounds.previous": "上一轮",
        "rounds.next": "下一轮",
        "rounds.latest": "最新",
        "rounds.incomplete": "仅显示最近轮次",
        "rounds.truncated": "部分内容已截断",
      })[key] ?? key,
  }),
}));

describe("RoundNavigator", () => {
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

  const rounds = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

  async function renderNavigator(
    selectedRoundId: string | null,
    onSelectRound: (roundId: string | null) => void,
    roundsComplete = true,
    truncated = false
  ) {
    await act(async () => {
      root.render(
        React.createElement(RoundNavigator, {
          rounds,
          roundsComplete,
          truncated,
          selectedRoundId,
          onSelectRound,
        })
      );
    });
  }

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label
    );
    if (!match) throw new Error(`missing ${label} button`);
    return match;
  }

  it("navigates previous, next, and latest with null follow-latest semantics", async () => {
    const onSelectRound = vi.fn();
    await renderNavigator(null, onSelectRound);
    expect(container.textContent).toContain("第 3 / 3 轮");
    expect(button("下一轮").disabled).toBe(true);
    expect(button("最新").disabled).toBe(true);

    act(() => button("上一轮").click());
    expect(onSelectRound).toHaveBeenLastCalledWith("r2");

    await renderNavigator("r1", onSelectRound);
    act(() => button("下一轮").click());
    expect(onSelectRound).toHaveBeenLastCalledWith("r2");

    await renderNavigator("r2", onSelectRound);
    act(() => button("下一轮").click());
    expect(onSelectRound).toHaveBeenLastCalledWith(null);
    act(() => button("最新").click());
    expect(onSelectRound).toHaveBeenLastCalledWith(null);
  });

  it("labels a partial round directory without hiding navigation", async () => {
    await renderNavigator("r1", vi.fn(), false);
    expect(container.textContent).toContain("仅显示最近轮次");
    expect(button("下一轮").disabled).toBe(false);
  });

  it("labels a truncated round body", async () => {
    await renderNavigator("r1", vi.fn(), true, true);
    expect(container.textContent).toContain("部分内容已截断");
  });
});
