// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import ReactArtifactRunner, {
  __resetReactArtifactPublisherForTests,
  canvasArtifactUrl,
  reactArtifactId,
} from "./ReactArtifactRunner";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

/** Flush pending publish promises + the resulting React commits. */
async function flushPublishes(): Promise<void> {
  await dispatch(() => {});
  await dispatch(() => {});
}

describe("ReactArtifactRunner runtime", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    __resetReactArtifactPublisherForTests();
  });

  it("surfaces compile failures as a visible alert and forwards onError", async () => {
    const root = createSmokeRoot();
    const onError = vi.fn();
    // Unbalanced parenthesis — the sucrase compile step must throw.
    const source = "function App( { return null; }";

    try {
      await root.render(
        React.createElement(ReactArtifactRunner, { source, onError })
      );

      const banner = root.container.querySelector(
        '[data-testid="react-artifact-error"]'
      );
      expect(banner).not.toBeNull();
      expect(banner?.getAttribute("role")).toBe("alert");
      expect(banner?.textContent?.trim().length).toBeGreaterThan(0);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.any(String) })
      );
      // Uncompilable source must never be published.
      expect(mocks.invoke).not.toHaveBeenCalled();
    } finally {
      await root.unmount();
    }
  });

  it("publishes once and renders a sandboxed iframe for the artifact", async () => {
    const root = createSmokeRoot();
    const onError = vi.fn();
    const source =
      "export default function App() { return <button>publish-once</button>; }";

    try {
      await root.render(
        React.createElement(ReactArtifactRunner, { source, onError })
      );
      await flushPublishes();

      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(mocks.invoke).toHaveBeenCalledWith("canvas_artifact_publish", {
        id: reactArtifactId(source),
        html: expect.stringContaining("ReactDOM.createRoot"),
      });

      const frame = root.container.querySelector(
        '[data-testid="react-artifact-frame"]'
      ) as HTMLIFrameElement | null;
      expect(frame).not.toBeNull();
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame?.getAttribute("src")).toBe(
        canvasArtifactUrl(reactArtifactId(source))
      );

      // Parent-only re-renders with the same source must not publish again.
      await root.render(
        React.createElement(ReactArtifactRunner, { source, onError })
      );
      await flushPublishes();
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await root.unmount();
    }
  });

  it("keeps the iframe element and src stable across parent re-renders", async () => {
    const root = createSmokeRoot();
    const source =
      "export default function App() { return <div>stable frame</div>; }";

    try {
      await root.render(
        React.createElement(ReactArtifactRunner, { source, onError: vi.fn() })
      );
      await flushPublishes();

      const originalFrame = root.container.querySelector(
        '[data-testid="react-artifact-frame"]'
      );
      expect(originalFrame).not.toBeNull();
      const originalSrc = originalFrame?.getAttribute("src");

      await root.render(
        React.createElement(ReactArtifactRunner, { source, onError: vi.fn() })
      );
      await flushPublishes();

      const frameAfterRerender = root.container.querySelector(
        '[data-testid="react-artifact-frame"]'
      );
      // Same DOM node — the artifact document keeps its runtime state.
      expect(frameAfterRerender).toBe(originalFrame);
      expect(frameAfterRerender?.getAttribute("src")).toBe(originalSrc);
    } finally {
      await root.unmount();
    }
  });

  it("publishes a new id and swaps the iframe src when the source changes", async () => {
    const root = createSmokeRoot();
    const firstSource =
      "export default function App() { return <div>first</div>; }";
    const secondSource =
      "export default function App() { return <div>second</div>; }";

    try {
      await root.render(
        React.createElement(ReactArtifactRunner, {
          source: firstSource,
          onError: vi.fn(),
        })
      );
      await flushPublishes();
      const firstSrc = root.container
        .querySelector('[data-testid="react-artifact-frame"]')
        ?.getAttribute("src");

      await root.render(
        React.createElement(ReactArtifactRunner, {
          source: secondSource,
          onError: vi.fn(),
        })
      );
      await flushPublishes();

      expect(mocks.invoke).toHaveBeenCalledTimes(2);
      expect(reactArtifactId(firstSource)).not.toBe(
        reactArtifactId(secondSource)
      );
      const secondSrc = root.container
        .querySelector('[data-testid="react-artifact-frame"]')
        ?.getAttribute("src");
      expect(secondSrc).toBe(canvasArtifactUrl(reactArtifactId(secondSource)));
      expect(secondSrc).not.toBe(firstSrc);
    } finally {
      await root.unmount();
    }
  });

  it("surfaces publish failures as a visible alert and forwards onError", async () => {
    const root = createSmokeRoot();
    const onError = vi.fn();
    mocks.invoke.mockRejectedValue(new Error("store unavailable"));
    const source =
      "export default function App() { return <div>publish fails</div>; }";

    try {
      await root.render(
        React.createElement(ReactArtifactRunner, { source, onError })
      );
      await flushPublishes();

      const banner = root.container.querySelector(
        '[data-testid="react-artifact-error"]'
      );
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain("store unavailable");
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "store unavailable" })
      );
      expect(
        root.container.querySelector('[data-testid="react-artifact-frame"]')
      ).toBeNull();
    } finally {
      await root.unmount();
    }
  });

  it("builds platform-aware artifact URLs", () => {
    expect(canvasArtifactUrl("ra-1234abcd", true)).toBe(
      "http://canvas-artifact.localhost/ra-1234abcd"
    );
    expect(canvasArtifactUrl("ra-1234abcd", false)).toBe(
      "canvas-artifact://localhost/ra-1234abcd"
    );
  });

  it("derives deterministic ids that satisfy the backend grammar", () => {
    const source = "export default function App() { return <div/>; }";
    const id = reactArtifactId(source);
    expect(id).toBe(reactArtifactId(source));
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
