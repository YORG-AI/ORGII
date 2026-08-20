// @vitest-environment jsdom
import { type ReactNode, act, createElement } from "react";
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

import CanvasShareDialog from "./CanvasShareDialog";
import type { CanvasShareDialogState } from "./useCanvasShareDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string | { defaultValue?: string }) =>
      typeof fallback === "string" ? fallback : (fallback.defaultValue ?? _key),
    i18n: { language: "en" },
  }),
}));
vi.mock("@/src/scaffold/ModalSystem", () => ({
  default: ({
    visible,
    children,
  }: {
    visible: boolean;
    children: ReactNode;
  }) => (visible ? createElement("div", null, children) : null),
}));
vi.mock("@src/components/Input", () => ({
  default: ({
    errorMessage: _errorMessage,
    ...props
  }: {
    errorMessage?: string;
  }) => createElement("input", props),
}));
vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    htmlType,
    loading: _loading,
    href: _href,
    target: _target,
    rel: _rel,
    ...props
  }: {
    children?: ReactNode;
    htmlType?: "button";
    loading?: boolean;
    href?: string;
    target?: string;
    rel?: string;
  }) => createElement("button", { type: htmlType, ...props }, children),
}));

describe("CanvasShareDialog fallback recovery", () => {
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

  function render(
    state: CanvasShareDialogState,
    onRetryShortLink = vi.fn(),
    onRetry = vi.fn()
  ) {
    act(() => {
      root.render(
        createElement(CanvasShareDialog, {
          state,
          onClose: vi.fn(),
          onRetry,
          onRetryShortLink,
          onCopy: vi.fn(),
        })
      );
    });
    return onRetryShortLink;
  }

  function fallbackState(retryingShortLink: boolean): CanvasShareDialogState {
    return {
      phase: "ready",
      operationId: 1,
      title: "Fallback",
      payload: { mode: "html", content: "<p>Fallback</p>" },
      link: "https://example.test/#/share/g1/full",
      linkKind: "self-contained",
      copied: false,
      copyError: false,
      retryingShortLink,
    };
  }

  it("keeps the full link visible while retrying the short link", () => {
    const retry = render(fallbackState(false));
    const retryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry short link"
    );

    act(() => retryButton?.click());
    expect(retry).toHaveBeenCalledOnce();

    render(fallbackState(true), retry);
    expect(container.querySelector("input")?.getAttribute("value")).toBe(
      "https://example.test/#/share/g1/full"
    );
    const retryingButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retrying…"
    );
    expect(retryingButton?.hasAttribute("disabled")).toBe(true);
  });

  it("explains a service outage with an oversized fallback and offers retry", () => {
    const onRetry = vi.fn();
    render(
      {
        phase: "error",
        operationId: 1,
        title: "Big",
        payload: { mode: "html", content: "<p>Big</p>" },
        error: "short-unavailable-too-large",
      },
      vi.fn(),
      onRetry
    );

    expect(container.textContent).toContain(
      "The share service is temporarily unreachable and this Canvas is too large for a self-contained link. Try again in a moment."
    );
    expect(container.textContent).not.toContain(
      "This Canvas is too large for a reliable self-contained link."
    );
    const retryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry"
    );
    act(() => retryButton?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps the plain too-large message for a genuinely oversized Canvas", () => {
    render({
      phase: "error",
      operationId: 1,
      title: "Huge",
      payload: { mode: "html", content: "<p>Huge</p>" },
      error: "source-too-large",
    });

    expect(container.textContent).toContain(
      "This Canvas is too large for a reliable self-contained link."
    );
  });
});
