import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

describe("Button", () => {
  it("uses GitHub purple for the merged variant", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Button, { variant: "merged" }, "Merged")
    );
    expect(markup).toContain("bg-merged");
    expect(markup).toContain("text-merged-contrast");
  });

  it("keeps icon + label centered as one group by default", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        Button,
        { icon: React.createElement("i", null), long: true },
        "Close"
      )
    );
    expect(markup).not.toContain("right-full");
    expect(markup).toContain("mr-2");
  });

  it("lifts the icon out of flow so centerLabel centers the label alone", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        Button,
        { icon: React.createElement("i", null), long: true, centerLabel: true },
        "Close"
      )
    );
    // Icon anchored to the label's left edge (right: 100%) plus its mr-2 gap,
    // so only the label participates in the button's centering.
    expect(markup).toContain("absolute inset-y-0 inline-flex items-center");
    expect(markup).toContain("right-full");
  });

  it("keeps a right-positioned icon out of flow under centerLabel", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        Button,
        {
          icon: React.createElement("i", null),
          iconPosition: "right",
          long: true,
          centerLabel: true,
        },
        "Close"
      )
    );
    expect(markup).toContain("left-full");
    expect(markup).not.toContain("right-full");
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
