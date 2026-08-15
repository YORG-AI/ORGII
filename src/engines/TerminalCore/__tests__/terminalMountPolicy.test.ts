import { selectMountedTerminalSession } from "../terminalMountPolicy";
import type { TerminalSession } from "../types";

function createSession(id: string): TerminalSession {
  return { id, name: `Terminal ${id}`, isActive: id === "active" };
}

describe("selectMountedTerminalSession", () => {
  const sessions = [
    createSession("inactive-a"),
    createSession("active"),
    createSession("inactive-b"),
  ];

  it("selects only the active session while the terminal surface is visible", () => {
    expect(selectMountedTerminalSession(sessions, "active", true)?.id).toBe(
      "active"
    );
  });

  it("selects no session while the terminal surface is hidden", () => {
    expect(
      selectMountedTerminalSession(sessions, "active", false)
    ).toBeUndefined();
  });

  it("selects no session when the active id is stale", () => {
    expect(
      selectMountedTerminalSession(sessions, "missing", true)
    ).toBeUndefined();
  });

  it("handles an empty session list", () => {
    expect(selectMountedTerminalSession([], "active", true)).toBeUndefined();
  });
});
