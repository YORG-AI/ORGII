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
}));

vi.mock("@src/store/ui/overlayLayerAtom", () => ({
  useOverlayLayer: mocks.useOverlayLayer,
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
  it("registers the full-screen wrapper instead of only the dialog panel", async () => {
    await act(async () => root.render(renderModal(true)));

    const [, coverageRef] = mocks.useOverlayLayer.mock.calls.at(-1) as [
      boolean,
      RefObject<HTMLDivElement | null>,
    ];
    const wrapper = document.querySelector(".liquid-modal-wrapper");
    const panel = document.querySelector(".liquid-modal-content");

    expect(wrapper).not.toBeNull();
    expect(coverageRef.current).toBe(wrapper);
    expect(coverageRef.current).not.toBe(panel);
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
