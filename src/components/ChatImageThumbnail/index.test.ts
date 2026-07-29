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

import { ChatImageThumbnail } from ".";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: mocks.readFile,
}));

vi.mock("@src/components/ImagePreviewOverlay", () => ({
  default: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ChatImageThumbnail", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders an unavailable placeholder when a local image is missing", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("not found"));

    await act(async () => {
      root.render(
        createElement(ChatImageThumbnail, {
          imageRef: "/tmp/missing-screenshot.png",
          alt: "Attached image 1",
        })
      );
    });

    expect(mocks.readFile).toHaveBeenCalledWith("/tmp/missing-screenshot.png");
    expect(
      container.querySelector('[data-image-state="unavailable"]')
    ).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders available data images immediately", async () => {
    await act(async () => {
      root.render(
        createElement(ChatImageThumbnail, {
          imageRef: "data:image/png;base64,c21hbGw=",
          alt: "Attached image 1",
        })
      );
    });

    expect(
      container.querySelector('[data-image-state="ready"]')
    ).not.toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,c21hbGw="
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
