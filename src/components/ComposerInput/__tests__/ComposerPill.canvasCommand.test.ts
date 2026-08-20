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

import { EDITOR_FILE_PILL_TEXT_COLOR } from "@src/config/pillTokens";

import ComposerPill from "../ComposerPill";

describe("ComposerPill Canvas command icon", () => {
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

  function renderSkillPill(filePath: string, fileName: string) {
    act(() =>
      root.render(
        createElement(ComposerPill, {
          attrs: {
            filePath,
            fileName,
            iconType: "skill",
            isFolder: false,
            lineStart: null,
            lineEnd: null,
          },
          onDelete: vi.fn(),
        })
      )
    );
  }

  it("uses the Canvas icon for the /canvas command", () => {
    renderSkillPill("/canvas", "canvas");

    const canvasIcon = container.querySelector<SVGElement>(
      ".lucide-panels-top-left"
    );
    expect(canvasIcon).not.toBeNull();
    expect(canvasIcon?.style.color).toBe(EDITOR_FILE_PILL_TEXT_COLOR);
    expect(container.querySelector(".lucide-toolbox")).toBeNull();
  });

  it("keeps ordinary skill pills on the toolbox icon", () => {
    renderSkillPill("/compact", "compact");

    expect(container.querySelector(".lucide-toolbox")).not.toBeNull();
    expect(container.querySelector(".lucide-panels-top-left")).toBeNull();
  });
});
