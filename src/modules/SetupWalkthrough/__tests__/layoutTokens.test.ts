import { describe, expect, it } from "vitest";

import {
  SETUP_APPLICATION_PREVIEW_TOKENS,
  SETUP_WALKTHROUGH_LAYOUT_TOKENS,
} from "../layoutTokens";

describe("setup walkthrough layout tokens", () => {
  it("keeps preview and preferences side by side at desktop widths", () => {
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.shell).toContain("!flex");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.shell).toContain("!items-center");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.shell).toContain("!justify-center");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.card).toContain("!max-w-6xl");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.card).toContain("!rounded-2xl");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.main).toContain(
      "setup-walkthrough-main-panel"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.main).not.toContain("!bg-bg-1");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceList).toContain(
      "!bg-transparent"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceList).toContain(
      "!border-0"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceControl).toContain(
      "@[480px]:w-56"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebar).toContain("sm:!flex");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebar).toContain("!basis-5/12");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebarContent).toContain(
      "overflow-hidden"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.mainContent).toContain(
      "overflow-y-auto"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.stepFrame).toContain(
      "motion-reduce:animate-none"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid).toBe(
      "max-sm:!grid-cols-1"
    );
  });

  it("keeps the compact product preview focused on its primary workspace", () => {
    const {
      codeEditor,
      codeLine,
      codePanel,
      composer,
      contentArea,
      contentAreaSplit,
      navigation,
      summaryList,
      workspace,
      workspacePanel,
    } = SETUP_APPLICATION_PREVIEW_TOKENS;

    expect(navigation).toContain("w-12");
    expect(contentArea).toContain("grid-cols-1");
    expect(contentAreaSplit).toContain("grid-cols-2");
    expect(contentAreaSplit).toContain("overflow-hidden");
    expect(workspace).toContain("overflow-hidden");
    expect(codePanel).toContain("overflow-hidden");
    expect(workspacePanel).toContain("items-center");
    expect(workspacePanel).toContain("justify-center");
    expect(composer).toContain("max-w-xs");
    expect(summaryList).toContain("max-w-xs");
    expect(codeEditor).toContain("justify-evenly");
    expect(codeEditor).toContain("text-left");
    expect(codeLine).toContain("whitespace-nowrap");
    expect(codeLine).toContain("[&>code]:text-left");
  });
});
