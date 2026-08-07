import {
  getThoughtPreview,
  stripMarkdownForThoughtPreview,
} from "./thoughtPreview";

describe("stripMarkdownForThoughtPreview", () => {
  it("removes emphasis markers from thinking subtitles", () => {
    expect(
      stripMarkdownForThoughtPreview("**Grouping asset and icon changes**")
    ).toBe("Grouping asset and icon changes");
  });

  it("keeps readable content while removing common Markdown syntax", () => {
    const markdown = [
      "## Reviewing `Button.tsx`",
      "> Compare [the shared component](https://example.com) with:",
      "- **bold**, _italic_, and ~~old~~ styles",
    ].join("\n");

    expect(stripMarkdownForThoughtPreview(markdown)).toBe(
      "Reviewing Button.tsx Compare the shared component with: bold, italic, and old styles"
    );
  });

  it("does not remove underscores from plain identifiers", () => {
    expect(
      stripMarkdownForThoughtPreview("Checking user_profile_id next")
    ).toBe("Checking user_profile_id next");
  });
});

describe("getThoughtPreview", () => {
  it("truncates the plain-text result rather than leaving partial markup", () => {
    const preview = getThoughtPreview(`**${"a".repeat(120)}**`);

    expect(preview).toBe(`${"a".repeat(96)}...`);
    expect(preview).not.toContain("*");
  });
});
