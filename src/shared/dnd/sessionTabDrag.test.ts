import { describe, expect, it } from "vitest";

import {
  getSessionReferenceFromDragDetail,
  isPointInsideElement,
} from "./sessionTabDrag";

describe("isPointInsideElement", () => {
  it("includes the tab-strip edges and rejects points outside", () => {
    const element = {
      getBoundingClientRect: () => ({
        left: 10,
        right: 110,
        top: 20,
        bottom: 60,
      }),
    } as HTMLElement;

    expect(isPointInsideElement(element, 10, 20)).toBe(true);
    expect(isPointInsideElement(element, 110, 60)).toBe(true);
    expect(isPointInsideElement(element, 9, 40)).toBe(false);
    expect(isPointInsideElement(null, 50, 40)).toBe(false);
  });
});

describe("getSessionReferenceFromDragDetail", () => {
  it("parses sidebar session reference payloads", () => {
    expect(
      getSessionReferenceFromDragDetail({
        pill: {
          path: "session://codexapp-session-1",
          name: "Imported Codex session",
          iconType: "session",
        },
      })
    ).toEqual({
      sessionId: "codexapp-session-1",
      title: "Imported Codex session",
    });
  });

  it("rejects non-session references", () => {
    expect(
      getSessionReferenceFromDragDetail({
        pill: { path: "/repo/file.ts", name: "file.ts", iconType: "file" },
      })
    ).toBeNull();
  });
});
