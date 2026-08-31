import { describe, expect, it } from "vitest";

import { classifyMarkdownLinkTarget } from "./markdownLinkTarget";

describe("classifyMarkdownLinkTarget", () => {
  it.each([
    "src/engines/ChatPanel/ChatHistory/components/TurnMetadataFooter/index.tsx:310",
    "src/engines/ChatPanel/blocks/ToolCallBlock/cards/WebsiteCard.tsx:84",
    "src/components/MarkDown/LinkHoverCard.tsx:80",
    "src/modules/WorkStation/shared/StatusBar/PortsStatusMenu.tsx:128",
    "src/engines/Simulator/components/Dock/config.ts:33",
  ])("resolves a source-located repo href inside the workspace: %s", (href) => {
    expect(classifyMarkdownLinkTarget(href, "/repo")).toEqual({
      kind: "local",
      path: `/repo/${href}`,
    });
  });

  it("resolves a basename source href that generic URL parsing treats as a scheme", () => {
    expect(classifyMarkdownLinkTarget("WebsiteCard.tsx:84", "/repo")).toEqual({
      kind: "local",
      path: "/repo/WebsiteCard.tsx:84",
    });
  });

  it("resolves file-shaped repo hrefs without line suffixes", () => {
    expect(classifyMarkdownLinkTarget("docs/architecture.md", "/repo")).toEqual(
      { kind: "local", path: "/repo/docs/architecture.md" }
    );
    expect(classifyMarkdownLinkTarget("./package.json", "/repo")).toEqual({
      kind: "local",
      path: "/repo/package.json",
    });
    expect(classifyMarkdownLinkTarget("Dockerfile", "/repo")).toEqual({
      kind: "local",
      path: "/repo/Dockerfile",
    });
    expect(classifyMarkdownLinkTarget("src/My%20View.tsx:12", "/repo")).toEqual(
      {
        kind: "local",
        path: "/repo/src/My View.tsx:12",
      }
    );
  });

  it("uses the active workspace's path separator", () => {
    expect(
      classifyMarkdownLinkTarget("src/components/View.tsx:12", "C:\\repo")
    ).toEqual({
      kind: "local",
      path: "C:\\repo\\src\\components\\View.tsx:12",
    });
  });

  it("keeps route-like relative hrefs, anchors, and queries in the browser", () => {
    for (const href of [
      "docs/getting-started",
      "account/settings/",
      "#verification",
      "?tab=files",
      "//example.com/docs/start",
      "example.com/index.html",
      "localhost:3000",
      "mailto:source.ts",
      "vscode:source.ts:12",
    ]) {
      expect(classifyMarkdownLinkTarget(href, "/repo")).toEqual({
        kind: "browser",
        url: href,
      });
    }
  });

  it("does not resolve traversal outside the active workspace", () => {
    for (const href of [
      "../../outside/secrets.txt:12",
      "%2e%2e/%2e%2e/outside/secrets.txt:12",
    ]) {
      expect(classifyMarkdownLinkTarget(href, "/repo")).toEqual({
        kind: "browser",
        url: href,
      });
    }
  });

  it("preserves absolute local and remote link classification", () => {
    expect(
      classifyMarkdownLinkTarget("/Users/me/project/View.tsx:220", "/repo")
    ).toEqual({ kind: "local", path: "/Users/me/project/View.tsx:220" });
    expect(
      classifyMarkdownLinkTarget("https://example.com/docs/start", "/repo")
    ).toEqual({
      kind: "browser",
      url: "https://example.com/docs/start",
    });
  });

  it("does not guess a relative filesystem path without an active workspace", () => {
    expect(classifyMarkdownLinkTarget("src/View.tsx:12", "")).toEqual({
      kind: "browser",
      url: "src/View.tsx:12",
    });
  });
});
