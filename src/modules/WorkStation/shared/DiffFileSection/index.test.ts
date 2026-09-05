// @vitest-environment jsdom
import { Provider } from "jotai";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import DiffFileSection from ".";

vi.mock("@src/components/FileTypeIcon", () => ({
  default: () => React.createElement("span", { "data-file-icon": true }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../SelectedTextAddToChat", () => ({
  SelectedTextAddToChat: ({
    children,
    displayName,
    enabled,
  }: {
    children?: React.ReactNode;
    displayName: string;
    enabled?: boolean;
  }) =>
    React.createElement(
      "div",
      {
        "data-selected-text-owner": displayName,
        "data-selection-enabled": enabled,
      },
      children
    ),
}));

const FILE = {
  path: "src/index.tsx",
  status: "modified" as const,
  staged: false,
};
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

function renderSection(compactHeaderGutter = false) {
  return renderToStaticMarkup(
    React.createElement(
      Provider,
      null,
      React.createElement(DiffFileSection, {
        file: FILE,
        viewMode: "unified",
        defaultExpanded: false,
        compactHeaderGutter,
      })
    )
  );
}

describe("DiffFileSection header gutter", () => {
  it("keeps every collapsible file row at 36px", () => {
    const markup = renderSection();

    expect(markup).toContain("h-9 w-full");
    expect(markup).not.toContain("py-2");
  });

  it("keeps the shared gutter by default", () => {
    const markup = renderSection();

    expect(markup).toContain("px-3");
    expect(markup).not.toContain("px-2");
  });

  it("supports the compact Source Control gutter", () => {
    const markup = renderSection(true);

    expect(markup).toContain("px-2");
    expect(markup).not.toContain("px-3");
  });
});

describe("DiffFileSection selected-text ownership", () => {
  it("mounts the shared Add to Chat owner around expanded diff content", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        Provider,
        null,
        React.createElement(DiffFileSection, {
          file: {
            ...FILE,
            oldContent: "const before = 1;",
            newContent: "const after = 2;",
          },
          viewMode: "unified",
          defaultExpanded: true,
        })
      )
    );

    expect(markup).toContain('data-selected-text-owner="index.tsx"');
    expect(markup).toContain('data-selection-enabled="true"');
  });
});

describe("DiffFileSection open-file action", () => {
  it("underlines only the filename when the file can open in an editor tab", () => {
    const withoutAction = renderSection();
    const withAction = renderToStaticMarkup(
      React.createElement(
        Provider,
        null,
        React.createElement(DiffFileSection, {
          file: FILE,
          viewMode: "unified",
          defaultExpanded: false,
          onFileSelect: vi.fn(),
        })
      )
    );

    expect(withoutAction).not.toContain('data-icon="open-file-arrow"');
    expect(withAction).not.toContain('data-icon="open-file-arrow"');
    expect(withAction).toContain("hover:underline");
    expect(withAction).toContain("focus-visible:underline");
    expect(withAction).toContain("text-[13px] leading-normal");
    const markupContainer = document.createElement("div");
    markupContainer.innerHTML = withAction;
    expect(markupContainer.querySelector("button button")).toBeNull();
  });

  it("opens the absolute working-copy path without toggling the diff", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onFileSelect = vi.fn();

    act(() => {
      root.render(
        React.createElement(
          Provider,
          null,
          React.createElement(DiffFileSection, {
            file: FILE,
            viewMode: "unified",
            defaultExpanded: false,
            repoPath: "/workspace/project",
            onFileSelect,
          })
        )
      );
    });

    const openFileButton = Array.from(
      container.querySelectorAll("button")
    ).find((button) => button.textContent === "index.tsx");
    expect(openFileButton).not.toBeNull();
    expect(openFileButton?.textContent).toBe("index.tsx");

    act(() => openFileButton?.click());

    expect(onFileSelect).toHaveBeenCalledOnce();
    expect(onFileSelect).toHaveBeenCalledWith(
      "/workspace/project/src/index.tsx"
    );
    expect(
      container.querySelector('[data-icon="chevron-right"]')
    ).not.toBeNull();
    expect(container.querySelector('[data-icon="chevron-down"]')).toBeNull();

    const disclosureButton = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]'
    );
    act(() => disclosureButton?.click());

    expect(onFileSelect).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-icon="chevron-down"]')
    ).not.toBeNull();

    act(() => root.unmount());
  });
});
