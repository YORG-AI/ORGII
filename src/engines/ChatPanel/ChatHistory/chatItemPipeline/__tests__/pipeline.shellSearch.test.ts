/**
 * Shell-search classification tests: run_shell events whose command is a pure
 * grep/rg pipeline group with explorations, not terminal stacks.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeSessionEvent,
  resetActivityCounter,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import {
  getActionSummaryCategory,
  isShellSearchCommandEvent,
  isTerminalCommandEvent,
} from "../classifiers";
import { processChatItems } from "../pipeline";
import { makeReadFileItem, makeShellItem } from "./pipeline.testUtils";

beforeEach(() => {
  resetActivityCounter();
});

function makeGrepShellItem(command: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "run_shell",
    uiCanonical: "run_shell",
    args: { command },
    result: {
      output: {
        success: { command, stdout: "src/a.ts:1:hit", exitCode: 0 },
      },
    },
  });
}

describe("shell-search classifiers", () => {
  it("classifies grep pipelines as search summary events", () => {
    const grepEvent = makeGrepShellItem('grep -rn "foo" src | head -20');
    expect(isShellSearchCommandEvent(grepEvent)).toBe(true);
    expect(getActionSummaryCategory(grepEvent)).toBe("search");
    expect(isTerminalCommandEvent(grepEvent)).toBe(false);
  });

  it("keeps ordinary shell commands in the terminal stack", () => {
    const shellEvent = makeShellItem("npm run build");
    expect(isShellSearchCommandEvent(shellEvent)).toBe(false);
    expect(getActionSummaryCategory(shellEvent)).toBeNull();
    expect(isTerminalCommandEvent(shellEvent)).toBe(true);
  });

  it("groups grep shells with explorations in the pipeline", () => {
    const readItem = makeReadFileItem("a.ts");
    const grepItem = makeGrepShellItem('grep -rn "handleClick" src');

    const { items } = processChatItems([readItem, grepItem], {
      groupActionSummaries: true,
      preFilterEmptyActivities: false,
    });

    expect(items.length).toBe(1);
    expect(items[0].type).toBe("actionSummaryGroup");
    expect(items[0].actionSummaryItems?.length).toBe(2);
    expect(items[0].actionSummaryItems?.[1].category).toBe("search");
  });

  it("keeps non-grep shells out of the exploration group", () => {
    const readItem = makeReadFileItem("a.ts");
    const shellItem = makeShellItem("npm test");

    const { items } = processChatItems([readItem, shellItem], {
      groupActionSummaries: true,
      groupTerminalActivities: true,
      preFilterEmptyActivities: false,
    });

    const summaryGroups = items.filter(
      (item) => item.type === "actionSummaryGroup"
    );
    expect(summaryGroups.length).toBe(0);
    const terminalStacks = items.filter(
      (item) => item.type === "activityStackGroup"
    );
    expect(terminalStacks.length).toBe(1);
  });
});
