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

import BottomSheet from "./index";

vi.mock("@src/store/ui/overlayLayerAtom", () => ({
  useOverlayLayer: vi.fn(),
}));

describe("BottomSheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("renders dialog semantics when open", () => {
    act(() => {
      root.render(
        React.createElement(
          BottomSheet,
          { open: true, title: "Approve command" },
          "Body"
        )
      );
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.body.textContent).toContain("Approve command");
    expect(document.body.textContent).toContain("Body");
  });

  it("does not mount when closed", () => {
    act(() => {
      root.render(
        React.createElement(BottomSheet, { open: false, title: "Hidden" })
      );
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("calls onClose when scrim is clicked and dismissible", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        React.createElement(BottomSheet, {
          open: true,
          dismissible: true,
          onClose,
          title: "Approve",
        })
      );
    });
    const scrim = document.body.querySelector(
      ".orgii-bottom-sheet-scrim"
    ) as HTMLButtonElement;
    scrim.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders an accessible close button when requested", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        React.createElement(BottomSheet, {
          open: true,
          onClose,
          title: "Tool details",
          closeLabel: "Close tool details",
          showCloseButton: true,
        })
      );
    });

    const closeButton = document.body.querySelector<HTMLButtonElement>(
      '.orgii-bottom-sheet-close[aria-label="Close tool details"]'
    );
    expect(closeButton).not.toBeNull();
    act(() => closeButton?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the panel mounted during its closing animation", () => {
    vi.useFakeTimers();
    function Harness() {
      const [open, setOpen] = React.useState(true);
      return React.createElement(BottomSheet, {
        open,
        onClose: () => setOpen(false),
        title: "Tool details",
      });
    }
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      document.body
        .querySelector<HTMLButtonElement>(".orgii-bottom-sheet-scrim")
        ?.click();
    });

    const wrapper = document.body.querySelector(".orgii-bottom-sheet-wrapper");
    expect(wrapper?.className).toContain("orgii-bottom-sheet-wrapper--closing");
    act(() => vi.advanceTimersByTime(180));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("ignores scrim clicks when not dismissible", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        React.createElement(BottomSheet, {
          open: true,
          dismissible: false,
          onClose,
          title: "Approve",
        })
      );
    });
    const scrim = document.body.querySelector(
      ".orgii-bottom-sheet-scrim"
    ) as HTMLButtonElement;
    scrim.click();
    expect(onClose).not.toHaveBeenCalled();
  });
});
