import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A commit/PR reference written as [`654d839`](https://github.com/...) renders
 * an inline `code` element inside the anchor. `.chat-markdown-body code` paints
 * a fill-2 chip with text-1 text in the monospace stack, which outranked
 * nothing and therefore won — the link read as a neutral grey pill in a second
 * typeface while the same href written in plain text read as a primary-6 body
 * link. These assertions pin the label back to the anchor's color and type so
 * every link renders in one font, without disturbing standalone inline code.
 */
function readBaseElements(): string {
  return readFileSync(resolve(__dirname, "_base-elements.scss"), "utf8");
}

function ruleBody(styles: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped} \\{([\\s\\S]*?)\\n\\}`))?.[1];
}

describe("markdown link label styles", () => {
  it("keeps the anchor itself on the primary accent token", () => {
    const rule = ruleBody(readBaseElements(), ".chat-markdown-body a");

    expect(rule).toContain("color: var(--color-primary-6)");
  });

  it("lets inline code inside a link inherit the link color", () => {
    const styles = readBaseElements();
    const rule = ruleBody(
      styles,
      ".chat-markdown-body a code,\n.chat-markdown-body a tt"
    );

    expect(rule).toContain("color: inherit");
    expect(rule).toContain("background: transparent");
    expect(rule).toContain("padding: 0");
  });

  it("renders a link label in the surrounding font, not the code stack", () => {
    const rule = ruleBody(
      readBaseElements(),
      ".chat-markdown-body a code,\n.chat-markdown-body a tt"
    );

    expect(rule).toContain("font-family: inherit");
    expect(rule).toContain("font-size: inherit");
    expect(rule).toContain("font-weight: inherit");
    expect(rule).not.toContain("monospace");
    expect(rule).not.toContain("--code-font-family");
    expect(rule).not.toContain("--chat-code-font-size");
  });

  it("leaves standalone inline code on the neutral monospace chip", () => {
    const chip = readFileSync(
      resolve(__dirname, "_code-blocks.scss"),
      "utf8"
    ).match(
      /\.chat-markdown-body code,\n\.chat-markdown-body tt \{([\s\S]*?)\n\}/
    )?.[1];

    expect(chip).toContain("background: var(--color-fill-2)");
    expect(chip).toContain("color: var(--color-text-1)");
    expect(chip).toContain("--code-font-family");
  });
});
