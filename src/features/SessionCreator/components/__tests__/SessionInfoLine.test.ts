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

import { REPO_KIND } from "@src/store/repo";

import SessionInfoLine from "../SessionInfoLine";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/scaffold/GlobalSpotlight/palettes/BranchPalette", () => ({
  BranchPalette: () => null,
}));

vi.mock(
  "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/BranchDropdown",
  () => ({ BranchDropdown: () => null })
);

vi.mock("@src/scaffold/GlobalSpotlight/palettes/WorkspacePalette", () => ({
  WorkspacePalette: () => null,
}));

vi.mock(
  "@src/scaffold/GlobalSpotlight/palettes/WorkspacePalette/WorkspaceDropdown",
  () => ({ WorkspaceDropdown: () => null })
);

describe("SessionInfoLine", () => {
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

  it("renders leading controls before the repository, location, and branch pills", () => {
    act(() => {
      root.render(
        createElement(SessionInfoLine, {
          repoId: "repo-1",
          repoKind: REPO_KIND.GIT,
          repoName: "ORGII",
          branchName: "main",
          worktreeLocation: "local",
          leadingContent: createElement(
            "div",
            { "data-testid": "cli-launch-mode" },
            "GUI / TUI"
          ),
        })
      );
    });

    const launchMode = container.querySelector<HTMLElement>(
      '[data-testid="cli-launch-mode"]'
    );
    const repository = container.querySelector<HTMLElement>(
      '[aria-label="selectors.sessionInfo.sourceAria"]'
    );
    const location = container.querySelector<HTMLElement>(
      '[aria-label="selectors.sessionInfo.locationAria"]'
    );
    const branch = container.querySelector<HTMLElement>(
      '[aria-label="selectors.sessionInfo.branchAria"]'
    );

    expect(launchMode).not.toBeNull();
    expect(repository).not.toBeNull();
    expect(location).not.toBeNull();
    expect(branch).not.toBeNull();
    expect(launchMode?.parentElement?.classList.contains("gap-0")).toBe(true);
    expect(launchMode?.compareDocumentPosition(repository!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(launchMode?.compareDocumentPosition(location!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(launchMode?.compareDocumentPosition(branch!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
