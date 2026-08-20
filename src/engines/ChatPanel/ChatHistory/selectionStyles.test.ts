import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("chat transcript selection styles", () => {
  it("uses the shared text-selection token for specific Markdown selectors", () => {
    const styles = readFileSync(resolve(__dirname, "index.scss"), "utf8");
    const markdownSelectionRule = styles.match(
      /\.chat-markdown-body[\s\S]*?code span::selection \{([\s\S]*?)\n\s{2}\}/
    )?.[1];

    expect(markdownSelectionRule).toContain("--text-selection");
    expect(markdownSelectionRule).not.toContain("--terminal-selection");
  });

  it("does not paint selection backgrounds on layout wrappers", () => {
    const styles = readFileSync(resolve(__dirname, "index.scss"), "utf8");
    const deepSelectionRule = styles.match(
      /\.allow-select-deep\s+:is\(([^)]*)\)::selection \{([\s\S]*?)\n\s{2}\}/
    );

    expect(deepSelectionRule?.[1]).toContain("span");
    expect(deepSelectionRule?.[1]).not.toContain("*");
    expect(deepSelectionRule?.[2]).toContain("--text-selection");
    expect(styles).not.toContain(".allow-select-deep *::selection");
  });

  it("keeps layout wrappers inert while allowing semantic text elements", () => {
    const styles = readFileSync(resolve(__dirname, "index.scss"), "utf8");
    const wrapperRule = styles.match(
      /\.allow-select-deep \* \{([\s\S]*?)\n\s{2}\}/
    )?.[1];
    const textAllowlist = styles.match(
      /\.allow-select-deep\s+:is\(([^)]*)\),\n\s{2}\.question-text/
    )?.[1];

    expect(wrapperRule).toContain("user-select: none !important");
    expect(textAllowlist).toContain("span");
    expect(textAllowlist).toContain("time");
  });

  it.each(["orgii_main.css", "orgii_dark.css", "orgii_high_contrast.css"])(
    "defines a visible text-selection color in %s",
    (themeFile) => {
      const theme = readFileSync(resolve("public", themeFile), "utf8");
      expect(theme).toMatch(/--text-selection:\s*#[0-9a-f]{6}/i);
    }
  );
});
