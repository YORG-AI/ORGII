// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import ReactArtifactRunner from "./ReactArtifactRunner";

describe("ReactArtifactRunner runtime", () => {
  it("renders stateful generated sketches and keeps controls interactive", async () => {
    const root = createSmokeRoot();
    const onError = vi.fn();
    const source = `
      const { useState } = React;
      function App() {
        const [count, setCount] = useState(0);
        return React.createElement(
          "button",
          {
            type: "button",
            style: { background: "rgb(86, 109, 232)", color: "white" },
            onClick: () => setCount((value) => value + 1)
          },
          "Count " + count
        );
      }
    `;

    try {
      await root.render(
        React.createElement(ReactArtifactRunner, { source, onError })
      );

      const button = root.container.querySelector("button");
      expect(button?.textContent).toBe("Count 0");
      expect(button?.style.background).toBe("rgb(86, 109, 232)");

      await dispatch(() => button?.click());

      expect(button?.textContent).toBe("Count 1");
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await root.unmount();
    }
  });

  it("provides a bounded native scroll container for tall sketches", async () => {
    const root = createSmokeRoot();
    const source = `
      function App() {
        return React.createElement("div", { style: { height: 1200 } }, "Tall sketch");
      }
    `;

    try {
      await root.render(React.createElement(ReactArtifactRunner, { source }));

      const scrollContainer = root.container.querySelector(
        '[data-testid="react-artifact-scroll"]'
      );
      expect(scrollContainer?.classList.contains("overflow-auto")).toBe(true);
    } finally {
      await root.unmount();
    }
  });
});
