// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCanvasPreviewHtml,
  captureCanvasElement,
  elementFromComposedPath,
} from "./canvasDomCapture";

describe("Canvas DOM capture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the deepest inspectable element through an open ShadowRoot", () => {
    const root = document.createElement("div");
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const target = document.createElement("button");
    shadow.appendChild(target);
    root.appendChild(host);

    const event = {
      composedPath: () => [target, shadow, host, root, document, window],
    } as unknown as Event;

    expect(elementFromComposedPath(event, root)).toBe(target);
  });

  it("ignores Design overlay controls", () => {
    const root = document.createElement("div");
    const control = document.createElement("button");
    control.setAttribute("data-canvas-design-ui", "");
    root.appendChild(control);
    const event = {
      composedPath: () => [control, root, document, window],
    } as unknown as Event;

    expect(elementFromComposedPath(event, root)).toBeNull();
  });

  it("captures bounded context and a sanitized visual preview", () => {
    const target = document.createElement("div");
    target.dataset.component = "Stat";
    target.setAttribute("data-value", "M");
    target.setAttribute("onclick", "alert(1)");
    target.innerHTML = '<strong style="font-size:28px">M</strong>';
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 130,
      bottom: 100,
      width: 120,
      height: 80,
      toJSON: () => ({}),
    });
    document.body.appendChild(target);

    const capture = captureCanvasElement(target);
    const preview = buildCanvasPreviewHtml(target);

    expect(capture.label).toBe("Stat");
    expect(capture.elementInfo.attributes).toEqual({
      "data-component": "Stat",
      "data-value": "M",
    });
    expect(capture.rect).toEqual({ x: 10, y: 20, width: 120, height: 80 });
    expect(preview).toContain("font-size:28px");
    expect(preview).not.toContain("onclick");

    target.remove();
  });

  it("falls back to a text preview when computed styles cannot be serialized", () => {
    const target = document.createElement("div");
    target.textContent = "Selection stays usable";
    document.body.appendChild(target);
    const getComputedStyle = window.getComputedStyle.bind(window);
    let styleReadCount = 0;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      styleReadCount += 1;
      if (styleReadCount > 1) {
        throw new DOMException("Unsupported computed style");
      }
      return getComputedStyle(element);
    });

    const capture = captureCanvasElement(target);

    expect(capture.previewHtml).toContain("Selection stays usable");
    target.remove();
  });

  it("preserves the nearest opaque ancestor background for readable previews", () => {
    const surface = document.createElement("section");
    surface.style.backgroundColor = "rgb(12, 18, 28)";
    const target = document.createElement("h1");
    target.style.color = "white";
    target.textContent = "Readable heading";
    surface.appendChild(target);
    document.body.appendChild(surface);

    const preview = buildCanvasPreviewHtml(target);

    expect(preview).toContain('data-canvas-preview-context="true"');
    expect(preview).toContain("background-color: rgb(12, 18, 28)");
    expect(preview).toContain("Readable heading");
    surface.remove();
  });
});
