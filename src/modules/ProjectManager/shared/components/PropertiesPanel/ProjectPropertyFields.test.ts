// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProjectPropertyFields from "./ProjectPropertyFields";
import type { ProjectData } from "./types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const project: ProjectData = {
  id: "project-1",
  name: "ORGII",
  status: "backlog",
  priority: "none",
  health: "no_updates",
  completionPercentage: 0,
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ProjectPropertyFields", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps creator pills compact while exposing other properties in More", () => {
    const linkedRepo = { id: "repo-1", name: "orgii-cloud-infra" };
    const onUpdate = vi.fn();
    act(() => {
      root.render(
        createElement(ProjectPropertyFields, {
          project: { ...project, linkedRepos: [linkedRepo] },
          availableRepos: [linkedRepo],
          onUpdate,
          fieldVariant: "pill",
          visibleFields: ["status", "priority"],
          showMoreMenu: true,
        })
      );
    });

    expect(container.textContent).toContain("properties.statusOptions.backlog");
    expect(container.textContent).toContain("properties.priorityOptions.none");
    expect(container.textContent).not.toContain(linkedRepo.name);

    const moreButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="workItems.contextMenu.moreProperties"]'
    );
    expect(moreButton).not.toBeNull();
    expect(moreButton?.style.width).toBe("28px");
    expect(moreButton?.style.height).toBe("28px");
    expect(moreButton?.style.borderRadius).toBe("50%");

    act(() => moreButton!.click());

    for (const field of ["lead", "linkedRepos", "targetDate"]) {
      expect(
        document.querySelector(`[data-context-menu-item-id="${field}"]`)
      ).not.toBeNull();
    }
    expect(
      document.querySelector('[data-context-menu-item-id="linkedRepos"]')
        ?.textContent
    ).toContain(linkedRepo.name);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("can use Work Item row formatting without the legacy text-label column", () => {
    act(() => {
      root.render(
        createElement(ProjectPropertyFields, {
          project,
          availableRepos: [],
          showLabels: false,
          withGroupInset: false,
        })
      );
    });

    expect(container.textContent).toContain("properties.statusOptions.backlog");
    expect(
      Array.from(container.querySelectorAll("span")).some(
        (element) => element.textContent === "properties.status"
      )
    ).toBe(false);
    expect(
      Array.from(container.querySelectorAll("span")).some((element) =>
        element.className.includes("w-[72px]")
      )
    ).toBe(false);
  });
});
