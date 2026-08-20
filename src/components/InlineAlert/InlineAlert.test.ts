import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Button from "@src/components/Button";

import InlineAlert from ".";

describe("InlineAlert", () => {
  it("forwards an explicit live-region role", () => {
    const markup = renderToStaticMarkup(
      createElement(InlineAlert, { type: "danger", role: "alert" }, "Failed")
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Failed");
  });

  it("renders one neutral surface for every type", () => {
    const types = ["success", "danger", "warning", "info"] as const;

    for (const type of types) {
      const markup = renderToStaticMarkup(
        createElement(InlineAlert, { type }, "Body")
      );

      expect(markup).toContain("border-border-1");
      expect(markup).toContain("shadow-dropdown-soft");
      expect(markup).not.toContain("border-danger-3");
      expect(markup).not.toContain("border-warning-3");
      expect(markup).not.toContain("text-danger-6");
      expect(markup).not.toContain("text-warning-6");
    }
  });

  it("makes title, body and subtitle text selectable", () => {
    const markup = renderToStaticMarkup(
      createElement(
        InlineAlert,
        { type: "danger", title: "Failed", subtitle: "Retry later" },
        "Stack trace"
      )
    );

    const selectableCount = markup.split("allow-select-deep").length - 1;
    expect(selectableCount).toBe(3);
  });

  it("groups the action and tertiary close button with a one-pixel gap", () => {
    const markup = renderToStaticMarkup(
      createElement(
        InlineAlert,
        {
          title: "Upgrade required",
          action: createElement(Button, {
            variant: "tertiary",
            iconOnly: true,
            icon: "Refresh",
            "aria-label": "Refresh",
          }),
          onClose: () => undefined,
          closeAriaLabel: "Close",
        },
        "Upgrade the CLI"
      )
    );

    expect(markup).toContain("gap-px");
    expect(markup.indexOf('aria-label="Refresh"')).toBeLessThan(
      markup.indexOf('aria-label="Close"')
    );
    expect(markup.split("enabled:hover:bg-surface-hover").length - 1).toBe(2);
  });
});
