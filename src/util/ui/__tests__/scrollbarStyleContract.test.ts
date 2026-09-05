import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("scrollbar style contract", () => {
  it("defines one shared no-scrollbar utility for compact chrome and chat panes", () => {
    const styles = readSource("src/tailwind.css");
    const hiddenScrollbarUtility = styles.slice(
      styles.indexOf("@utility scrollbar-hide"),
      styles.indexOf("/*\n * v3-preflight compatibility")
    );

    expect(hiddenScrollbarUtility).toContain("scrollbar-width: none");
    expect(hiddenScrollbarUtility).toMatch(
      /&::-webkit-scrollbar\s*{\s*display: none;/
    );
  });

  it("keeps the global transient scrollbar below explicit surface policies", () => {
    const styles = readSource("src/index.scss");
    const globalScrollbarSection = styles.slice(
      styles.indexOf("// Global scrollbar styles"),
      styles.indexOf("// Settings surfaces")
    );

    expect(globalScrollbarSection).toMatch(
      /@layer base\s*{\s*\*\s*{\s*@include scrollbar\.scrollbar-unified;/
    );
    expect(globalScrollbarSection).not.toMatch(
      /\/\/ Global scrollbar styles[^\S\r\n]*\r?\n\*\s*{/
    );
  });

  it.each([
    "src/engines/ChatPanel/ChatHistory/components/ChatHistoryList.tsx",
    "src/engines/ChatPanel/ChatPanelTabBar/index.tsx",
    "src/modules/shared/components/FileHeader/BreadcrumbFileHeader.tsx",
    "src/modules/WorkStation/shared/TabBar/index.tsx",
    "src/modules/WorkStation/shared/SessionReplay/ReplayTabBar.tsx",
  ])("keeps %s on the shared no-scrollbar policy", (relativePath) => {
    expect(readSource(relativePath)).toContain("scrollbar-hide");
  });
});
