import { describe, expect, it } from "vitest";

import { classifyMarkdownImageSrc } from "./markdownImageSrc";

describe("classifyMarkdownImageSrc", () => {
  it("skips empty sources", () => {
    expect(classifyMarkdownImageSrc(undefined)).toEqual({ kind: "skip" });
    expect(classifyMarkdownImageSrc("   ")).toEqual({ kind: "skip" });
  });

  it("passes data and web urls through as remote", () => {
    expect(classifyMarkdownImageSrc("data:image/png;base64,AAA")).toEqual({
      kind: "remote",
      src: "data:image/png;base64,AAA",
    });
    expect(classifyMarkdownImageSrc("https://example.com/a.png")).toEqual({
      kind: "remote",
      src: "https://example.com/a.png",
    });
  });

  it("classifies absolute paths as local", () => {
    expect(
      classifyMarkdownImageSrc("/Users/me/project/assets/final.png")
    ).toEqual({ kind: "local", path: "/Users/me/project/assets/final.png" });
    expect(classifyMarkdownImageSrc("C:\\pets\\sprite.png")).toEqual({
      kind: "local",
      path: "C:\\pets\\sprite.png",
    });
  });

  it("decodes percent-encoded local paths", () => {
    expect(classifyMarkdownImageSrc("/Users/me/Desktop/a%20b.png")).toEqual({
      kind: "local",
      path: "/Users/me/Desktop/a b.png",
    });
  });

  it("converts tauri asset urls back to paths", () => {
    expect(
      classifyMarkdownImageSrc("asset://localhost/Users/me/a.png")
    ).toEqual({ kind: "local", path: "/Users/me/a.png" });
  });

  it("converts file urls to paths", () => {
    expect(classifyMarkdownImageSrc("file:///Users/me/a.png")).toEqual({
      kind: "local",
      path: "/Users/me/a.png",
    });
  });

  it("marks tilde paths home-relative", () => {
    expect(classifyMarkdownImageSrc("~/Desktop/a.png")).toEqual({
      kind: "local",
      path: "Desktop/a.png",
      homeRelative: true,
    });
  });

  it("resolves relative paths against the workspace root", () => {
    expect(
      classifyMarkdownImageSrc("assets/final.png", "/Users/me/project")
    ).toEqual({ kind: "local", path: "/Users/me/project/assets/final.png" });
    expect(
      classifyMarkdownImageSrc("./assets/final.png", "/Users/me/project/")
    ).toEqual({ kind: "local", path: "/Users/me/project/assets/final.png" });
  });

  it("skips relative paths without a workspace root", () => {
    expect(classifyMarkdownImageSrc("assets/final.png")).toEqual({
      kind: "skip",
    });
  });
});
