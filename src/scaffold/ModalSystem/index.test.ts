// @vitest-environment jsdom
import React, { type RefObject, act } from "react";
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

import Modal from "./index";

const mocks = vi.hoisted(() => ({
  useOverlayLayer: vi.fn(),
  theme: { isDark: false },
}));

vi.mock("@src/store/ui/overlayLayerAtom", () => ({
  useOverlayLayer: mocks.useOverlayLayer,
}));
vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ theme: "test", isDark: mocks.theme.isDark }),
}));

function renderModal(visible: boolean) {
  return React.createElement(
    Modal,
    { visible, title: "Coverage test", footer: null },
    "Modal body"
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mocks.useOverlayLayer.mockReset();
  mocks.theme.isDark = false;
});

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

afterAll(() => {
  Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Modal native surface coverage", () => {
  it("registers the opaque panel and dims the live native page", async () => {
    await act(async () => root.render(renderModal(true)));

    const [, coverageRef, options] = mocks.useOverlayLayer.mock.calls.at(
      -1
    ) as [
      boolean,
      RefObject<HTMLDivElement | null>,
      { nativeDimmingAlpha: number },
    ];
    const wrapper = document.querySelector(".liquid-modal-wrapper");
    const panel = document.querySelector(".liquid-modal-content");

    expect(wrapper).not.toBeNull();
    expect(coverageRef.current).toBe(panel);
    expect(coverageRef.current).not.toBe(wrapper);
    expect(options).toEqual({ nativeDimmingAlpha: 0.6 });
  });

  it("matches the stronger dark-theme modal scrim", async () => {
    mocks.theme.isDark = true;
    await act(async () => root.render(renderModal(true)));

    const [, , options] = mocks.useOverlayLayer.mock.calls.at(-1) as [
      boolean,
      RefObject<HTMLDivElement | null>,
      { nativeDimmingAlpha: number },
    ];

    expect(options).toEqual({ nativeDimmingAlpha: 0.7 });
  });

  it("publishes the inactive state and unmounts coverage when closed", async () => {
    await act(async () => root.render(renderModal(true)));
    await act(async () => root.render(renderModal(false)));

    const [active, coverageRef] = mocks.useOverlayLayer.mock.calls.at(-1) as [
      boolean,
      RefObject<HTMLDivElement | null>,
    ];

    expect(active).toBe(false);
    expect(coverageRef.current).toBeNull();
    expect(document.querySelector(".liquid-modal-wrapper")).toBeNull();
  });
});
