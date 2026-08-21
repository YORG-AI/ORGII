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

import MarkdownLocalImage, { openLocalMarkdownRef } from "./MarkdownLocalImage";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(async () => ({ isDirectory: false })),
  openFileInWorkStation: vi.fn(),
  openFileInEditor: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: mocks.readFile,
  stat: mocks.stat,
}));

vi.mock("@src/util/ui/openFileInEditor", () => ({
  openFileInEditor: mocks.openFileInEditor,
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(async () => "/Users/me"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

vi.mock("@src/util/ui/openFileInWorkStation", () => ({
  openFileInWorkStation: mocks.openFileInWorkStation,
}));

vi.mock("@src/components/ImagePreviewOverlay", () => ({
  default: () =>
    createElement("div", { "data-testid": "image-preview-overlay" }),
}));

vi.mock("@src/components/FileTypeIcon", () => ({
  default: () => createElement("span", { "data-testid": "file-type-icon" }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("MarkdownLocalImage", () => {
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

  function renderInsideLink(props: Record<string, unknown>): {
    anchorNavigations: () => number;
  } {
    let navigations = 0;
    act(() => {
      root.render(
        createElement(
          "a",
          {
            href: "/Users/me/artifact.png",
            onClick: (event: MouseEvent) => {
              if (!event.defaultPrevented) navigations += 1;
            },
          },
          createElement(MarkdownLocalImage, props)
        )
      );
    });
    return { anchorNavigations: () => navigations };
  }

  it("opens the preview overlay on click and never lets a wrapping link navigate", async () => {
    mocks.readFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    const { anchorNavigations } = renderInsideLink({
      src: "/Users/me/artifact.png",
      alt: "artifact",
    });
    await act(async () => {});

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    await act(async () => {
      img?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });

    expect(
      container.querySelector('[data-testid="image-preview-overlay"]')
    ).not.toBeNull();
    expect(anchorNavigations()).toBe(0);
    expect(mocks.openFileInWorkStation).not.toHaveBeenCalled();
  });

  it("renders non-image local paths as a file chip that opens in the WorkStation without reading the file", async () => {
    const { anchorNavigations } = renderInsideLink({
      src: "/Users/me/demo-final.mp4",
      alt: "demo",
    });
    await act(async () => {});

    expect(mocks.readFile).not.toHaveBeenCalled();
    const chip = container.querySelector('[data-image-state="file"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("demo");

    await act(async () => {
      chip?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });

    expect(mocks.openFileInWorkStation).toHaveBeenCalledWith(
      "/Users/me/demo-final.mp4"
    );
    expect(anchorNavigations()).toBe(0);
  });

  it("resolves home-relative file chips against the home directory", async () => {
    act(() => {
      root.render(
        createElement(MarkdownLocalImage, { src: "~/clips/demo.mov" })
      );
    });
    await act(async () => {});

    const chip = container.querySelector('[data-image-state="file"]');
    await act(async () => {
      chip?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });

    expect(mocks.openFileInWorkStation).toHaveBeenCalledWith(
      "/Users/me/clips/demo.mov"
    );
  });

  it("reveals directories in the editor instead of opening a file tab", async () => {
    mocks.stat.mockResolvedValueOnce({ isDirectory: true });
    await openLocalMarkdownRef("/Users/me/.codex/pets/locke", false);

    expect(mocks.openFileInEditor).toHaveBeenCalledWith(
      "/Users/me/.codex/pets/locke",
      { isDirectory: true }
    );
    expect(mocks.openFileInWorkStation).not.toHaveBeenCalled();
  });

  it("opens markdown file references at their line without including the suffix in the path", async () => {
    await openLocalMarkdownRef(
      "/Users/me/project/SessionCreatorChatPanelView.tsx:220",
      false
    );

    expect(mocks.stat).toHaveBeenCalledWith(
      "/Users/me/project/SessionCreatorChatPanelView.tsx"
    );
    expect(mocks.openFileInWorkStation).toHaveBeenCalledWith(
      "/Users/me/project/SessionCreatorChatPanelView.tsx",
      { line: 220 }
    );
  });

  it("falls back to the file tab when the path cannot be stat'ed", async () => {
    mocks.stat.mockRejectedValueOnce(new Error("gone"));
    await openLocalMarkdownRef("/Users/me/missing.png", false);

    expect(mocks.openFileInWorkStation).toHaveBeenCalledWith(
      "/Users/me/missing.png"
    );
    expect(mocks.openFileInEditor).not.toHaveBeenCalled();
  });

  it("contains clicks on missing-image placeholders", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("gone"));
    const { anchorNavigations } = renderInsideLink({
      src: "/Users/me/trashed.png",
      alt: "trashed",
    });
    await act(async () => {});

    const chip = container.querySelector('[data-image-state="unavailable"]');
    expect(chip).not.toBeNull();
    await act(async () => {
      chip?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });

    expect(anchorNavigations()).toBe(0);
    expect(mocks.openFileInWorkStation).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="image-preview-overlay"]')
    ).toBeNull();
  });
});
