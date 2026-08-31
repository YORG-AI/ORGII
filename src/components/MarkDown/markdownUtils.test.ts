import { describe, expect, it, vi } from "vitest";

import {
  detectCodeType,
  normalizeCopyableMarkdownDocumentFence,
  openFileInEditor,
} from "./markdownUtils";

const mocks = vi.hoisted(() => ({
  openFileInEditor: vi.fn(),
}));

vi.mock("@src/util/ui/openFileInEditor", () => ({
  openFileInEditor: mocks.openFileInEditor,
}));

describe("normalizeCopyableMarkdownDocumentFence", () => {
  it("uses a longer outer fence for markdown documents with nested fences", () => {
    const input = [
      "```md",
      "## Summary",
      "",
      "## Verification",
      "",
      "```bash",
      "pnpm run lint",
      "```",
      "```",
    ].join("\n");

    expect(normalizeCopyableMarkdownDocumentFence(input)).toBe(
      [
        "````md",
        "## Summary",
        "",
        "## Verification",
        "",
        "```bash",
        "pnpm run lint",
        "```",
        "````",
      ].join("\n")
    );
  });

  it("uses a fence longer than the longest nested fence", () => {
    const input = [
      "````markdown",
      "Example:",
      "````text",
      "nested",
      "````",
      "````",
    ].join("\n");

    expect(normalizeCopyableMarkdownDocumentFence(input)).toBe(
      ["`````markdown", "Example:", "````text", "nested", "````", "`````"].join(
        "\n"
      )
    );
  });

  it("leaves non-document markdown unchanged", () => {
    const input = [
      "Before",
      "",
      "```md",
      "## Summary",
      "```",
      "",
      "After",
    ].join("\n");

    expect(normalizeCopyableMarkdownDocumentFence(input)).toBe(input);
  });

  it("leaves markdown documents without nested fences unchanged", () => {
    const input = ["```md", "## Summary", "Plain text", "```"].join("\n");

    expect(normalizeCopyableMarkdownDocumentFence(input)).toBe(input);
  });
});

describe("detectCodeType", () => {
  it("recognizes inline file paths with source location suffixes", () => {
    expect(detectCodeType("src/components/View.tsx:220")).toBe("file");
    expect(detectCodeType("src/components/View.tsx:220:14")).toBe("file");
  });
});

describe("openFileInEditor", () => {
  it("passes markdown source locations as a clean path and target line", () => {
    openFileInEditor("src/components/View.tsx:220:14");

    expect(mocks.openFileInEditor).toHaveBeenCalledWith(
      "src/components/View.tsx",
      { isDirectory: false, line: 220 }
    );
  });
});

describe("openMarkdownLinkInBrowserApp", () => {
  function captureBrowserOpenEvents(): CustomEvent<{
    url: string;
    navigate?: boolean;
  }>[] {
    const events: CustomEvent<{ url: string; navigate?: boolean }>[] = [];
    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => {
        events.push(event as CustomEvent<{ url: string; navigate?: boolean }>);
        return true;
      },
    });
    return events;
  }

  it("brings the Browser into view for GitHub pull-request links", async () => {
    const events = captureBrowserOpenEvents();
    const { openMarkdownLinkInBrowserApp } = await import("./markdownUtils");

    openMarkdownLinkInBrowserApp("https://github.com/org2AI/ORG2/pull/851");

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("open-url-in-browser");
    expect(events[0].detail).toEqual({
      url: "https://github.com/org2AI/ORG2/pull/851",
      navigate: true,
    });
    vi.unstubAllGlobals();
  });

  it("keeps ordinary links in a background tab", async () => {
    const events = captureBrowserOpenEvents();
    const { openMarkdownLinkInBrowserApp } = await import("./markdownUtils");

    openMarkdownLinkInBrowserApp("https://github.com/org2AI/ORG2/issues/851");
    openMarkdownLinkInBrowserApp("https://example.com/docs");

    expect(events.map((event) => event.detail.navigate)).toEqual([
      false,
      false,
    ]);
    vi.unstubAllGlobals();
  });
});
