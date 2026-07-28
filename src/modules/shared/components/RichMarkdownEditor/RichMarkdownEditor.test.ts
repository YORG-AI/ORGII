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

import RichMarkdownEditor from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.preview": "Preview",
        "common.raw": "Raw",
        "common.nothingToPreview": "Nothing to preview",
      })[key] ?? key,
  }),
}));

vi.mock("@src/components/RichTextEditor", async () => {
  const { createElement, forwardRef, useImperativeHandle } =
    await import("react");
  return {
    default: forwardRef(function MockRichTextEditor(
      props: { matchMarkdownPreview?: boolean },
      ref
    ) {
      useImperativeHandle(ref, () => ({
        getText: () => "Hello",
        getHTML: () => "<p>Hello</p>",
        getJSON: () => undefined,
        getMarkdown: () => "**Hello**",
        setContent: () => undefined,
        clear: () => undefined,
        focus: () => undefined,
        isEmpty: () => false,
        insertImage: () => undefined,
        insertFilePill: () => undefined,
        removeFilePill: () => undefined,
        getFilePills: () => [],
        triggerAtMention: () => undefined,
        triggerSlashContext: () => undefined,
      }));
      return createElement("div", {
        "data-testid": "mock-rich-text-editor",
        "data-match-markdown-preview": String(props.matchMarkdownPreview),
      });
    }),
  };
});

vi.mock("@src/components/TabPill", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      tabs,
      activeTab,
      onChange,
    }: {
      tabs: Array<{ key: string; label: string }>;
      activeTab: string;
      onChange: (key: string) => void;
    }) =>
      createElement(
        "div",
        { "data-active-tab": activeTab },
        tabs.map((tab) =>
          createElement(
            "button",
            {
              key: tab.key,
              type: "button",
              "data-mode": tab.key,
              onClick: () => onChange(tab.key),
            },
            tab.label
          )
        )
      ),
  };
});

vi.mock("@src/modules/shared/components/MarkdownContent", async () => {
  const { createElement } = await import("react");
  return {
    MarkdownContent: ({ body }: { body: string }) =>
      createElement("div", { "data-testid": "mock-markdown-preview" }, body),
  };
});

describe("RichMarkdownEditor", () => {
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

  it("switches between the Raw rich editor and shared Preview renderer", () => {
    act(() => {
      root.render(
        React.createElement(RichMarkdownEditor, { value: "**Hello**" })
      );
    });

    expect(container.textContent).toContain("Preview");
    expect(container.textContent).toContain("Raw");
    expect(
      container.querySelector("[data-rich-markdown-raw]")?.className
    ).toContain("block");
    expect(container.querySelector("[data-rich-markdown-preview]")).toBeNull();
    expect(
      container
        .querySelector("[data-testid='mock-rich-text-editor']")
        ?.getAttribute("data-match-markdown-preview")
    ).toBe("true");

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[data-mode="preview"]')
        ?.click();
    });

    expect(container.querySelector("[data-rich-markdown-raw]")?.className).toBe(
      "hidden"
    );
    expect(
      container.querySelector("[data-rich-markdown-preview]")?.textContent
    ).toBe("**Hello**");
  });

  it("supports Preview as the initial read mode", () => {
    act(() => {
      root.render(
        React.createElement(RichMarkdownEditor, {
          value: "**Hello**",
          defaultMode: "preview",
        })
      );
    });

    expect(container.querySelector("[data-rich-markdown-raw]")?.className).toBe(
      "hidden"
    );
    expect(
      container.querySelector("[data-rich-markdown-preview]")?.textContent
    ).toBe("**Hello**");
  });
});
