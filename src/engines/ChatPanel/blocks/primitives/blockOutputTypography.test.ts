import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("BlockOutput typography", () => {
  it("uses the application font for chat result text", () => {
    const styles = readFileSync(
      resolve(__dirname, "_block-output.scss"),
      "utf8"
    );

    expect(styles).toMatch(
      /&__pre\s*\{[\s\S]*?font-family:\s*var\(--app-font-family\)\s*!important;/
    );
    expect(styles).toMatch(
      /&__line\s*\{[\s\S]*?font-family:\s*var\(--app-font-family\);/
    );
    expect(styles).not.toContain("--code-font-family");
  });
});
