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
    "src/modules/MainApp/Integrations/DevTools/playground/panels/PlaygroundChatPanel.tsx",
    "src/modules/shared/components/FileHeader/BreadcrumbFileHeader.tsx",
    "src/modules/WorkStation/shared/TabBar/index.tsx",
    "src/modules/WorkStation/shared/SessionReplay/ReplayTabBar.tsx",
    "src/scaffold/GlobalSpotlight/components/SpotlightTabs.tsx",
    "src/components/SettingsTable/SearchSortBar.tsx",
    "src/components/SettingsTable/index.tsx",
  ])("keeps %s on the shared no-scrollbar policy", (relativePath) => {
    expect(readSource(relativePath)).toContain("scrollbar-hide");
  });

  it("keeps visible scrollbar geometry and color stable across interaction", () => {
    const mixin = readSource("src/styles/mixins/_scrollbar.scss");
    const customScrollbar = readSource(
      "src/components/CustomScrollbar/index.scss"
    );

    expect(mixin).toContain("--scrollbar-hit-area-size");
    expect(mixin).toContain("--scrollbar-edge-inset");
    expect(mixin).not.toContain("scrollbar-thumb-hover-color");
    expect(customScrollbar).not.toMatch(/&:hover[\s\S]*?(width|transform):/);
  });

  it("keeps xterm visual width out of its measured column layout", () => {
    const setup = readSource(
      "src/engines/TerminalCore/components/TerminalInteractive/terminalSetup.ts"
    );

    expect(setup).toContain("XTERM_OVERLAY_LAYOUT_WIDTH = Number.EPSILON");
    expect(setup).toContain(
      "overviewRuler: { width: XTERM_OVERLAY_LAYOUT_WIDTH }"
    );
  });
});
