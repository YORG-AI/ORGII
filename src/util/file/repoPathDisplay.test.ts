import { describe, expect, it } from "vitest";

import {
  formatPathForPlatformDisplay,
  formatRepoPathForDisplay,
  formatToolTargetPath,
  pickToolArgString,
} from "./repoPathDisplay";

describe("formatRepoPathForDisplay", () => {
  it("formats absolute paths relative to a disambiguating root label", () => {
    expect(
      formatRepoPathForDisplay({
        path: "/tmp/workspace-a/app/src/index.ts",
        repoPath: "/tmp/workspace-a/app",
      }).displayPath
    ).toBe(formatPathForPlatformDisplay("workspace-a/app/src/index.ts"));

    expect(
      formatRepoPathForDisplay({
        path: "/tmp/workspace-b/app/src/index.ts",
        repoPath: "/tmp/workspace-b/app",
      }).displayPath
    ).toBe(formatPathForPlatformDisplay("workspace-b/app/src/index.ts"));
  });

  it("keeps relative paths root-qualified when repo context exists", () => {
    const display = formatRepoPathForDisplay({
      path: "src/index.ts",
      repoPath: "/tmp/workspace-a/app",
    });

    expect(display.displayPath).toBe(
      formatPathForPlatformDisplay("workspace-a/app/src/index.ts")
    );
    expect(display.title).toBe("/tmp/workspace-a/app/src/index.ts");
  });

  it("does not strip sibling paths with a shared prefix", () => {
    const display = formatRepoPathForDisplay({
      path: "/tmp/repo-other/src/index.ts",
      repoPath: "/tmp/repo",
    });

    expect(display.displayPath).toBe(
      formatPathForPlatformDisplay("/tmp/repo-other/src/index.ts")
    );
  });

  it("uses platform separators for Windows display", () => {
    const display = formatRepoPathForDisplay({
      path: "C:\\work\\repo\\src\\index.ts",
      repoPath: "C:\\work\\repo",
    });

    expect(display.displayPath).toBe(
      formatPathForPlatformDisplay("work/repo/src/index.ts")
    );
    expect(display.normalizedPath).toBe("C:/work/repo/src/index.ts");
  });

  it("extracts nested tool arguments consistently", () => {
    expect(
      pickToolArgString(
        { tool_input: { repo_path: " /tmp/workspace-a/app " } },
        "repo_path",
        "repoPath"
      )
    ).toBe("/tmp/workspace-a/app");
  });

  it("formats tool targets with explicit repo path before generic path", () => {
    expect(
      formatToolTargetPath({
        args: {
          repo_path: "/tmp/workspace-b/app",
          path: "/tmp/workspace-a/app/src/index.ts",
        },
        repoPath: "/tmp/workspace-a/app",
        pathKeys: ["path"],
      })
    ).toBe(formatPathForPlatformDisplay("workspace-b/app"));
  });

  it("falls back to current repo when tool args omit a target", () => {
    expect(
      formatToolTargetPath({
        args: { pattern: "README" },
        repoPath: "/tmp/workspace-a/app",
        pathKeys: ["path"],
      })
    ).toBe(formatPathForPlatformDisplay("workspace-a/app"));
  });
});
