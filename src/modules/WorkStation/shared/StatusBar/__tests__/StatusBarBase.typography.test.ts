import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TYPOGRAPHY } from "@src/config/workstation/tokens";

import {
  BaseStatusBar,
  StatusBarLabel,
  type StatusBarLabelProps,
  StatusBarText,
  type StatusBarTextProps,
} from "../StatusBarBase";
import { STATUS_BAR_TOKENS, STATUS_BAR_TYPOGRAPHY } from "../statusBarTokens";

describe("status-bar typography", () => {
  it("derives the root style from the shared secondary-text token", () => {
    for (const token of TYPOGRAPHY.secondary.split(" ")) {
      expect(STATUS_BAR_TYPOGRAPHY.root).toContain(token);
    }
    expect(STATUS_BAR_TYPOGRAPHY.root).toContain("leading-none");
    expect(STATUS_BAR_TOKENS.typographyClass).toBe(STATUS_BAR_TYPOGRAPHY.root);
  });

  it("keeps extension-host items on the same typography contract", () => {
    for (const token of STATUS_BAR_TYPOGRAPHY.root.split(" ")) {
      expect(STATUS_BAR_TOKENS.extensionItem).toContain(token);
    }
  });

  it("renders semantic label weight and numeric variants", () => {
    const markup = renderToStaticMarkup(
      createElement(BaseStatusBar, {
        leftContent: createElement(
          StatusBarLabel,
          { emphasis: true, numeric: true } as StatusBarLabelProps,
          1501
        ),
        rightContent: createElement(
          StatusBarText,
          { numeric: true } as StatusBarTextProps,
          "Ln 1, Col 1"
        ),
      })
    );

    expect(markup).toContain(STATUS_BAR_TYPOGRAPHY.root);
    expect(markup).toContain("font-medium tabular-nums");
    expect(markup).toContain("font-normal tabular-nums");
  });
});
