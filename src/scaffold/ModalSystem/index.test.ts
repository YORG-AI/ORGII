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

import { MODAL_MASK_OCCLUSION_OPTIONS } from "@src/store/ui/overlayLayerAtom";

import Modal from "./index";

const mocks = vi.hoisted(() => ({
  useOverlayLayer: vi.fn(),
  theme: { isDark: false },
}));

vi.mock("@src/store/ui/overlayLayerAtom", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@src/store/ui/overlayLayerAtom")>();
  return {
    ...actual,
    useOverlayLayer: mocks.useOverlayLayer,
  };
});
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
  it("dims the live native page and masks the opaque panel", async () => {
    await act(async () => root.render(renderModal(true)));

    expect(mocks.useOverlayLayer).toHaveBeenCalledTimes(2);
    const [dimActive, dimRef, dimOptions] = mocks.useOverlayLayer.mock
      .calls[0] as [
      boolean,
      RefObject<HTMLDivElement | null>,
      { nativeDimmingAlpha: number; cutsNativeSurface: boolean },
    ];
    const [maskActive, maskRef, maskOptions] = mocks.useOverlayLayer.mock
      .calls[1] as [
      boolean,
      RefObject<HTMLDivElement | null>,
      typeof MODAL_MASK_OCCLUSION_OPTIONS,
    ];
    const panel = document.querySelector(".liquid-modal-content");

    expect(dimActive).toBe(true);
    expect(dimRef?.current).toBeUndefined();
    expect(dimOptions).toEqual({
      nativeDimmingAlpha: 0.6,
      cutsNativeSurface: false,
    });
    expect(maskActive).toBe(true);
    expect(maskRef.current).toBe(panel);
    expect(maskOptions).toEqual(MODAL_MASK_OCCLUSION_OPTIONS);
  });

  it("matches the stronger dark-theme modal scrim", async () => {
    mocks.theme.isDark = true;
    await act(async () => root.render(renderModal(true)));

    const [, , dimOptions] = mocks.useOverlayLayer.mock.calls[0] as [
      boolean,
      RefObject<HTMLDivElement | null>,
      { nativeDimmingAlpha: number },
    ];

    expect(dimOptions).toEqual({
      nativeDimmingAlpha: 0.7,
      cutsNativeSurface: false,
    });
  });

  it("publishes the inactive state and unmounts coverage when closed", async () => {
    await act(async () => root.render(renderModal(true)));
    await act(async () => root.render(renderModal(false)));

    expect(mocks.useOverlayLayer).toHaveBeenLastCalledWith(
      false,
      expect.any(Object),
      MODAL_MASK_OCCLUSION_OPTIONS
    );
    expect(document.querySelector(".liquid-modal-wrapper")).toBeNull();
  });
});
