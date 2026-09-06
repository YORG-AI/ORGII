// @vitest-environment jsdom
import React, { act, createElement } from "react";
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

import RevisionConflictModal from "./RevisionConflictModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/Textarea", () => ({
  default: ({
    value,
    autoSize: _autoSize,
    resize: _resize,
    ...props
  }: {
    value?: string;
    autoSize?: unknown;
    resize?: unknown;
  }) => createElement("textarea", { ...props, value, readOnly: true }),
}));

vi.mock("@src/scaffold/ModalSystem", () => ({
  default: ({
    visible,
    children,
    onCancel,
    onOk,
    cancelText,
    okText,
  }: {
    visible: boolean;
    children?: React.ReactNode;
    onCancel?: () => void;
    onOk?: () => void | Promise<void>;
    cancelText?: string;
    okText?: string;
  }) =>
    visible
      ? createElement(
          "section",
          null,
          children,
          createElement("button", { onClick: onCancel }, cancelText),
          createElement("button", { onClick: () => void onOk?.() }, okText)
        )
      : null,
}));

describe("RevisionConflictModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = false;
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

  it("shows both versions and exposes explicit latest/mine exits", () => {
    const useLatest = vi.fn();
    const keepMine = vi.fn();
    act(() => {
      root.render(
        createElement(RevisionConflictModal, {
          conflict: {
            fieldLabel: "Comment",
            mine: "my edit",
            latest: "teammate edit",
            expectedRevision: 2,
            actualRevision: 3,
          },
          onUseLatest: useLatest,
          onKeepMine: keepMine,
        })
      );
    });

    expect(
      container.querySelector<HTMLTextAreaElement>(
        "[data-testid='work-item-revision-conflict-mine']"
      )?.value
    ).toBe("my edit");
    expect(
      container.querySelector<HTMLTextAreaElement>(
        "[data-testid='work-item-revision-conflict-latest']"
      )?.value
    ).toBe("teammate edit");

    const buttons = container.querySelectorAll("button");
    act(() => buttons[0].click());
    act(() => buttons[1].click());
    expect(useLatest).toHaveBeenCalledTimes(1);
    expect(keepMine).toHaveBeenCalledTimes(1);
  });
});
