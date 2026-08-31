// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CREATOR_COMPOSER_POSITION } from "@src/config/sessionCreatorConfig";
import { changeCreatorComposerPositionAtom } from "@src/store/session/creatorRepoChromePositionAtom";

import CreatorContentLayout from "./CreatorContentLayout";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("CreatorContentLayout shared position", () => {
  let root: Root;
  let container: HTMLDivElement;
  let previousActEnvironment: boolean | undefined;

  beforeEach(() => {
    previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it("updates Work Item and Project layouts together without replacing their draft inputs", () => {
    const store = createStore();
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          ...["work-item", "project"].map((surface) =>
            createElement(
              CreatorContentLayout,
              {
                key: surface,
                placement: "bottom",
                contentDataTestId: surface,
                middleContent: createElement("h1", null, surface),
              },
              createElement("textarea", { defaultValue: `${surface} draft` })
            )
          )
        )
      );
    });

    const inputs = Array.from(container.querySelectorAll("textarea"));
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      input.value += " edited";
      expect(input.parentElement?.classList.contains("mt-auto")).toBe(true);
    }

    act(() => {
      store.set(
        changeCreatorComposerPositionAtom,
        CREATOR_COMPOSER_POSITION.MIDDLE
      );
    });
    expect(localStorage.getItem("orgii:newChat:composerPosition")).toBe(
      '"middle"'
    );
    for (const [index, input] of inputs.entries()) {
      expect(container.querySelectorAll("textarea")[index]).toBe(input);
      expect(input.value).toContain("draft edited");
      expect(input.parentElement?.classList.contains("mb-auto")).toBe(true);
      expect(
        input.parentElement?.parentElement?.classList.contains(
          "overflow-y-auto"
        )
      ).toBe(true);
    }

    act(() => {
      store.set(
        changeCreatorComposerPositionAtom,
        CREATOR_COMPOSER_POSITION.BOTTOM
      );
    });
    for (const [index, input] of inputs.entries()) {
      expect(container.querySelectorAll("textarea")[index]).toBe(input);
      expect(input.value).toContain("draft edited");
      expect(input.parentElement?.classList.contains("mt-auto")).toBe(true);
    }
  });

  it("leaves geometry to the Agent composer when the shared frame is fill-sized", () => {
    const store = createStore();
    store.set(
      changeCreatorComposerPositionAtom,
      CREATOR_COMPOSER_POSITION.MIDDLE
    );
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(
            CreatorContentLayout,
            { placement: "fill", contentDataTestId: "agent" },
            createElement("textarea", { defaultValue: "Agent draft" })
          )
        )
      );
    });
    const content = container.querySelector('[data-testid="agent"]');
    expect(content?.classList.contains("flex-1")).toBe(true);
    expect(content?.classList.contains("mb-auto")).toBe(false);
  });
});
