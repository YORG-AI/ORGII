import { beforeEach, describe, expect, it } from "vitest";

import { highlightLine, syntaxHighlightCacheTestApi } from "./syntaxHighlight";

describe("syntax highlight cache bounds", () => {
  beforeEach(() => syntaxHighlightCacheTestApi.reset());

  it("caches normal lines but never retains an oversize source line", () => {
    highlightLine("const answer = 42;", "typescript");
    expect(syntaxHighlightCacheTestApi.stats().entries).toBe(1);

    const oversize = "x".repeat(syntaxHighlightCacheTestApi.limits.sourceBytes);
    highlightLine(oversize, "typescript");

    const stats = syntaxHighlightCacheTestApi.stats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBeLessThanOrEqual(
      syntaxHighlightCacheTestApi.limits.bytes
    );
  });
});
