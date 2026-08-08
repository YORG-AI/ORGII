import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import Button from ".";

function readThemeColor(css: string, token: string): string {
  const match = css.match(
    new RegExp(`--color-${token}:\\s*(#[0-9a-f]{6})`, "i")
  );
  if (!match?.[1]) throw new Error(`Missing theme color: ${token}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) return 0;
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function renderSplitDropdownClassName(
  variant:
    | "primary"
    | "secondary"
    | "danger"
    | "warning"
    | "success"
    | "merged",
  dropdownVisible = false
): string {
  const markup = renderToStaticMarkup(
    React.createElement(
      Button,
      {
        variant,
        dropdownMenu: React.createElement("div"),
        onDropdownClick: vi.fn(),
        dropdownVisible,
      },
      "Action"
    )
  );
  const buttonClassNames = [...markup.matchAll(/<button[^>]*class="([^"]*)"/g)];
  return buttonClassNames.at(-1)?.[1] ?? "";
}

describe("Button split dropdown segment", () => {
  it("uses the success tone while hovered or open", () => {
    expect(renderSplitDropdownClassName("success")).toContain(
      "enabled:hover:bg-success-5"
    );
    expect(renderSplitDropdownClassName("success", true)).toContain(
      "bg-success-5 enabled:hover:bg-success-5"
    );
  });

  it("uses GitHub purple for the merged variant and its split state", () => {
    expect(renderSplitDropdownClassName("merged")).toContain(
      "enabled:hover:bg-merged-hover"
    );
    expect(renderSplitDropdownClassName("merged", true)).toContain(
      "bg-merged-hover enabled:hover:bg-merged-hover"
    );
    const markup = renderToStaticMarkup(
      React.createElement(Button, { variant: "merged" }, "Merged")
    );
    expect(markup).toContain("bg-merged");
    expect(markup).toContain("text-merged-contrast");
  });

  it.each([
    ["primary", "primary"],
    ["danger", "danger"],
    ["warning", "warning"],
  ] as const)("uses the %s tone for its semantic variant", (variant, tone) => {
    expect(renderSplitDropdownClassName(variant)).toContain(
      `enabled:hover:bg-${tone}-5`
    );
  });

  it("keeps neutral solid split buttons neutral", () => {
    expect(renderSplitDropdownClassName("secondary")).toContain(
      "enabled:hover:bg-fill-3"
    );
  });

  it.each(["orgii_main.css", "orgii_dark.css", "orgii_high_contrast.css"])(
    "keeps merged button states readable in %s",
    (themeFile) => {
      const css = readFileSync(resolve("public", themeFile), "utf8");
      const foreground = readThemeColor(css, "merged-button-contrast");

      for (const token of [
        "merged-button-bg",
        "merged-button-hover",
        "merged-button-active",
      ]) {
        expect(
          contrastRatio(foreground, readThemeColor(css, token)),
          `${themeFile} ${token}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  );
});
