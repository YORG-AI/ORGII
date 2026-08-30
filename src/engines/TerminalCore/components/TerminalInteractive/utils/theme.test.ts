// @vitest-environment jsdom
/**
 * The terminal cursor is painted by xterm's renderer from `ITheme.cursor`, not
 * by CSS, so it only matches the input caret if this resolver walks the same
 * token chain the stylesheets do: --terminal-caret -> --color-primary-6.
 *
 * That chain only exists in the body scope. The theme CSS declares its color
 * tokens on `body`, and the primary-color preset overrides --color-primary-*
 * inline on `body` as well — <html> can see neither, which is why reading the
 * token off `document.documentElement` used to leave the cursor on the theme's
 * default blue under every non-default accent.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TERMINAL_THEMES } from "@src/util/ui/terminal/themes";

import { getXTermTheme } from "./theme";

const LIGHT_BACKGROUND = "#ffffff";
const LIGHT_PRIMARY_6 = "#1d8ffd";
/** --color-primary-6 of the "violet" preset in light mode. */
const VIOLET_PRIMARY_6 = "#722ed1";

/** The shape the public theme CSS files declare: literals on :root, alias on body. */
function installThemeCss(): void {
  const style = document.createElement("style");
  style.textContent = `
    :root {
      --cm-editor-background: ${LIGHT_BACKGROUND};
      --cm-editor-caret: ${LIGHT_PRIMARY_6};
      --terminal-caret: ${LIGHT_PRIMARY_6};
      --terminal-selection: #efefef;
    }
    body {
      --color-primary-6: ${LIGHT_PRIMARY_6};
      --cm-editor-caret: var(--color-primary-6);
      --terminal-caret: var(--color-primary-6);
    }
  `;
  document.head.append(style);
}

describe("getXTermTheme cursor", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.removeAttribute("style");
  });

  it("resolves the accent the input caret uses", () => {
    installThemeCss();

    expect(getXTermTheme("light").cursor).toBe(LIGHT_PRIMARY_6);
  });

  it("follows a primary-color preset applied inline to body", () => {
    installThemeCss();
    document.body.style.setProperty("--color-primary-6", VIOLET_PRIMARY_6);

    expect(getXTermTheme("light").cursor).toBe(VIOLET_PRIMARY_6);
  });

  it("falls back to the palette default before the theme CSS loads", () => {
    expect(getXTermTheme("light").cursor).toBe(TERMINAL_THEMES.light.cursor);
  });
});
