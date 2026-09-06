import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

describe("Linux solid background policy", () => {
  it("publishes the resolved solid color as an app-shell CSS variable", () => {
    const source = readRepoFile("src/app/root/useAppShellEffects.ts");

    expect(source).toContain("useAtomValue(resolvedBackgroundConfigAtom)");
    expect(source).toContain('"--app-solid-background"');
    expect(source).toContain("backgroundConfig.backgroundColor");
  });

  it("paints every Linux root surface from the solid-color variable", () => {
    const scss = readRepoFile("src/index.scss");

    expect(scss).toMatch(
      /html\[data-host-desktop="linux"\],\s*html\[data-host-desktop="linux"\] body,\s*html\[data-host-desktop="linux"\] #root \{\s*background: var\(\s*--app-solid-background,\s*var\(--color-bg-2, var\(--splash-bg\)\)\s*\);/
    );
  });
});
