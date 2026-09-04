import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const tauriRoot = join(repositoryRoot, "apps/remote-ios/src-tauri");

function readRepositoryFile(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

describe("iOS launch configuration contract", () => {
  it("keeps devUrl at the origin and selects the mobile entry from the window URL", () => {
    const config = JSON.parse(
      readFileSync(join(tauriRoot, "tauri.conf.json"), "utf8")
    ) as {
      build: { devUrl: string };
      app: { windows: Array<{ url?: string }> };
    };
    const devUrl = new URL(config.build.devUrl);
    const windowUrl = config.app.windows[0]?.url;
    const resolvedWindowUrl = new URL(windowUrl ?? "", `${devUrl.origin}/`);

    expect(config.build.devUrl).toBe(devUrl.origin);
    expect(windowUrl).toBe("mobile-native.html");
    expect(resolvedWindowUrl.origin).toBe(devUrl.origin);
    expect(resolvedWindowUrl.pathname).toBe("/mobile-native.html");
  });

  it("runs xcode-script from the mobile src-tauri directory with the root binary", () => {
    const requiredPrefix =
      "cd ../.. && ../../../node_modules/.bin/tauri ios xcode-script";
    const generatedProjectSources = [
      "apps/remote-ios/src-tauri/gen/apple/project.yml",
      "apps/remote-ios/src-tauri/gen/apple/org2-remote.xcodeproj/project.pbxproj",
    ];

    for (const path of generatedProjectSources) {
      const source = readRepositoryFile(path);
      expect(source, path).toContain(requiredPrefix);
      expect(source, path).not.toMatch(
        /\bpnpm\s+tauri\s+ios\s+xcode-script\b/u
      );
    }
  });
});
