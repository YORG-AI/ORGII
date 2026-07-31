import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import InlineAlert from ".";

describe("InlineAlert", () => {
  it("forwards an explicit live-region role", () => {
    const markup = renderToStaticMarkup(
      createElement(InlineAlert, { type: "danger", role: "alert" }, "Failed")
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Failed");
  });
});
