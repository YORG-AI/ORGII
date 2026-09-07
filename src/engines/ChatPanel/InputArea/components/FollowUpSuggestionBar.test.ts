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

import type { SessionFollowUpSuggestion } from "@src/api/services/sessionFollowUpSuggestions";

import FollowUpSuggestionBar from "./FollowUpSuggestionBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: () => "Suggested next steps" }),
}));

const suggestions: SessionFollowUpSuggestion[] = [
  { label: "Open PR", prompt: "Open the PR.", primary: true },
  { label: "Run checks", prompt: "Run the checks.", primary: false },
  { label: "Review risks", prompt: "Review the risks.", primary: false },
];

describe("FollowUpSuggestionBar", () => {
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

  it("renders an accessible group and sends the selected suggestion", () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        React.createElement(FollowUpSuggestionBar, {
          suggestions,
          onSelect,
        })
      )
    );

    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toBe("Suggested next steps");
    const buttons = Array.from(group?.querySelectorAll("button") ?? []);
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Open PR",
      "Run checks",
      "Review risks",
    ]);
    expect(buttons[0]?.title).toBe("Open the PR.");

    act(() => buttons[1]?.click());
    expect(onSelect).toHaveBeenCalledWith(suggestions[1]);
  });

  it("disables every action while submit is unavailable", () => {
    act(() =>
      root.render(
        React.createElement(FollowUpSuggestionBar, {
          suggestions,
          disabled: true,
          onSelect: vi.fn(),
        })
      )
    );
    expect(
      Array.from(container.querySelectorAll("button")).every(
        (button) => button.disabled
      )
    ).toBe(true);
  });
});
