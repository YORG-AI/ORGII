import {
  TERMINAL_SESSION_LIST_COLUMN_BORDER_HOVER_CLASS,
  TERMINAL_SESSION_LIST_GROUP_CLASS,
  TERMINAL_SESSION_LIST_OUTER_CLASS,
  TERMINAL_SESSION_LIST_OUTER_RESIZING_LINE_CLASS,
  TERMINAL_SESSION_LIST_RESIZE_HANDLE_LINE_CLASS,
} from "../terminalSessionSidebarLayout";

describe("terminalSessionSidebarLayout tokens", () => {
  it("exposes a static Tailwind group name for JIT", () => {
    expect(TERMINAL_SESSION_LIST_GROUP_CLASS).toBe(
      "group/terminal-session-list"
    );
  });

  it("includes the group class on the outer wrapper", () => {
    expect(TERMINAL_SESSION_LIST_OUTER_CLASS).toContain(
      TERMINAL_SESSION_LIST_GROUP_CLASS
    );
    expect(TERMINAL_SESSION_LIST_OUTER_CLASS).toContain("flex");
  });

  it("wires resize handle line classes to the group", () => {
    expect(TERMINAL_SESSION_LIST_RESIZE_HANDLE_LINE_CLASS).toContain(
      "group-hover/terminal-session-list"
    );
  });

  it("defines resizing override and settings-preview border classes", () => {
    expect(
      TERMINAL_SESSION_LIST_OUTER_RESIZING_LINE_CLASS.length
    ).toBeGreaterThan(0);
    expect(TERMINAL_SESSION_LIST_COLUMN_BORDER_HOVER_CLASS).toContain(
      "border-l"
    );
  });
});
