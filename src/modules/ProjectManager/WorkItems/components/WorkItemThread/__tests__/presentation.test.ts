import { describe, expect, it } from "vitest";

import { resolveWorkItemThreadHeaderPolicy } from "../presentation";
import { WORK_ITEM_THREAD_TOKENS } from "../tokens";

describe("resolveWorkItemThreadHeaderPolicy", () => {
  it("omits the metadata band when no path or properties exist", () => {
    expect(resolveWorkItemThreadHeaderPolicy(false, false)).toEqual({
      showHeader: false,
      showSeparator: false,
    });
  });

  it.each([
    [true, false],
    [false, true],
  ])(
    "renders a single header source without a separator",
    (hasPath, hasProperties) => {
      expect(resolveWorkItemThreadHeaderPolicy(hasPath, hasProperties)).toEqual(
        {
          showHeader: true,
          showSeparator: false,
        }
      );
    }
  );

  it("separates the path from properties when both are present", () => {
    expect(resolveWorkItemThreadHeaderPolicy(true, true)).toEqual({
      showHeader: true,
      showSeparator: true,
    });
  });
});

describe("work item thread metadata presentation", () => {
  it("keeps card titles tinted while card bodies match the chat pane", () => {
    expect(WORK_ITEM_THREAD_TOKENS.card.split(" ")).toContain("bg-chat-pane");
    expect(WORK_ITEM_THREAD_TOKENS.cardBody.split(" ")).toContain(
      "bg-chat-pane"
    );
    expect(WORK_ITEM_THREAD_TOKENS.cardHeader.split(" ")).toContain(
      "bg-primary-container"
    );
    expect(WORK_ITEM_THREAD_TOKENS.collapsibleHeader.split(" ")).toContain(
      "bg-primary-container"
    );
  });

  it("uses an unframed control row without vertical padding", () => {
    const classNames = WORK_ITEM_THREAD_TOKENS.metadataBand.split(" ");

    expect(classNames).toContain("overflow-x-auto");
    expect(classNames.some((className) => className.startsWith("px-"))).toBe(
      false
    );
    expect(classNames.some((className) => className.startsWith("py-"))).toBe(
      false
    );
    expect(classNames.some((className) => className.startsWith("bg-"))).toBe(
      false
    );
    expect(classNames.some((className) => className.startsWith("border"))).toBe(
      false
    );
    expect(
      classNames.some((className) => className.startsWith("rounded"))
    ).toBe(false);
  });

  it("shares the PR detail column width and content gutters", () => {
    expect(WORK_ITEM_THREAD_TOKENS.contentColumn).toContain("max-w-[932px]");
    expect(WORK_ITEM_THREAD_TOKENS.flowHeader).toBe("px-4 pt-5");
    expect(WORK_ITEM_THREAD_TOKENS.contentBody).toContain("px-4 py-4");
    expect(WORK_ITEM_THREAD_TOKENS.contentColumn).not.toContain(
      "max-w-[920px]"
    );
  });

  it("shares leading and trailing axes between headers and child rows", () => {
    expect(WORK_ITEM_THREAD_TOKENS.alignedRowPadding).toBe("px-0 py-1");
    expect(WORK_ITEM_THREAD_TOKENS.leadingIconSlot).toContain("w-5");
    expect(WORK_ITEM_THREAD_TOKENS.trailingActionSlot).toContain("w-6");
    expect(WORK_ITEM_THREAD_TOKENS.emptyActionRow).not.toContain("px-");
  });
});
